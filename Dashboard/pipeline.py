"""
Project FORESIGHT — data & model pipeline
------------------------------------------
Loads the trained model (retail_demand_forecasting_model.pkl) and the
cleaned inventory dataset, engineers the same leakage-safe time-series
features used at training time, scores every SKU x Store combination,
and exposes a handful of query functions the Flask API calls.

Everything is computed once at import time and cached in memory —
this keeps the API endpoints fast (no re-training / re-scoring per request).
"""

from __future__ import annotations

import pickle
from pathlib import Path

import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MODEL_PATH = DATA_DIR / "retail_demand_forecasting_model.pkl"
CSV_PATH = DATA_DIR / "retail_store_inventory_cleaned.csv"

# Assumed operational constants (not present in the source dataset).
# In a production system these would come from a supplier/ops table.
DEFAULT_LEAD_TIME_DAYS = 7
CI_Z_SCORE = 1.28  # ~80% interval, two-sided normal approximation

QUADRANT_LABELS = {
    "reorder": "Reorder Now",
    "markdown": "Markdown / Clear",
    "watch": "Watch / Volatile",
    "healthy": "Healthy",
}


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def _load_artifact():
    with open(MODEL_PATH, "rb") as f:
        return pickle.load(f)


def _add_time_series_features(data, target, date_col, groups):
    """Identical feature engineering used in the training notebook so the
    model sees the exact same feature distribution at inference time."""
    result = data.copy()
    result = result.sort_values(groups + [date_col]).reset_index(drop=True)

    grouped = result.groupby(groups, sort=False)[target]

    for lag in [1, 7, 14, 28]:
        result[f"lag_{lag}"] = grouped.shift(lag)

    shifted = grouped.shift(1)

    for window in [7, 14, 28]:
        result[f"rolling_mean_{window}"] = (
            shifted.groupby([result[g] for g in groups], sort=False)
            .transform(lambda s: s.rolling(window, min_periods=1).mean())
        )
        if window in [7, 28]:
            result[f"rolling_std_{window}"] = (
                shifted.groupby([result[g] for g in groups], sort=False)
                .transform(lambda s: s.rolling(window, min_periods=2).std())
            )

    result["day_of_week"] = result[date_col].dt.dayofweek
    result["day_of_month"] = result[date_col].dt.day
    result["week_of_year"] = result[date_col].dt.isocalendar().week.astype(int)
    result["month"] = result[date_col].dt.month
    result["quarter"] = result[date_col].dt.quarter
    result["year"] = result[date_col].dt.year
    result["is_weekend"] = (result["day_of_week"] >= 5).astype(int)

    result["demand_trend_7"] = result["lag_1"] - result["lag_7"]
    result["demand_trend_28"] = result["lag_1"] - result["lag_28"]

    return result


class ForesightPipeline:
    """Loads data + model once and serves pre-computed lookups."""

    def __init__(self):
        artifact = _load_artifact()
        self.model = artifact["model"]
        self.feature_columns = artifact["feature_columns"]
        self.date_col = artifact["date_column"]
        self.target_col = artifact["target_column"]
        self.inventory_col = artifact["inventory_column"]
        self.product_col = artifact["product_column"]
        self.store_col = artifact["store_column"]
        self.price_col = artifact["price_column"]

        df = pd.read_csv(CSV_PATH)
        df[self.date_col] = pd.to_datetime(df[self.date_col])
        df = df.sort_values([self.product_col, self.store_col, self.date_col]).reset_index(drop=True)

        df["sku_id"] = df[self.product_col].astype(str) + "-" + df[self.store_col].astype(str)

        df_features = _add_time_series_features(
            df, self.target_col, self.date_col, [self.product_col, self.store_col]
        )

        scoreable = df_features.dropna(subset=self.feature_columns).copy()
        preds = self.model.predict(scoreable[self.feature_columns])
        scoreable["ml_forecast"] = np.clip(preds, 0, None)
        scoreable["baseline_forecast"] = scoreable["lag_1"].clip(lower=0)

        residuals = scoreable[self.target_col] - scoreable["ml_forecast"]
        self.residual_std = float(np.std(residuals))

        scoreable["ci_upper"] = scoreable["ml_forecast"] + CI_Z_SCORE * self.residual_std
        scoreable["ci_lower"] = (scoreable["ml_forecast"] - CI_Z_SCORE * self.residual_std).clip(lower=0)

        self.history = df  # full actuals, for charting even before lag warm-up
        self.scored = scoreable  # rows with model predictions available

        self._build_sku_snapshot()
        self._build_category_trend()

    # -------------------------------------------------------------------
    def _build_sku_snapshot(self):
        """Latest-date-per-SKU status table used for the decision matrix,
        KPI overview, and action lists."""
        latest_idx = (
            self.scored.sort_values(self.date_col)
            .groupby("sku_id")[self.date_col]
            .idxmax()
        )
        snap = self.scored.loc[latest_idx].copy().reset_index(drop=True)

        # --- Inventory economics -------------------------------------
        snap["on_hand"] = snap[self.inventory_col]
        snap["on_order"] = snap["Units Ordered"] if "Units Ordered" in snap.columns else 0
        snap["unit_price"] = snap[self.price_col]
        snap["lead_time_days"] = DEFAULT_LEAD_TIME_DAYS
        # Units needed on hand to cover expected demand until the next
        # delivery arrives (ml_forecast is a per-day forecast).
        snap["reorder_point"] = (snap["ml_forecast"] * snap["lead_time_days"]).round(1)

        safe_forecast = snap["ml_forecast"].replace(0, np.nan)
        snap["inventory_coverage_days"] = (snap["on_hand"] / safe_forecast * 7).round(1)

        # --- Risk scores (0-1 normalised) --------------------------------
        # Coverage thresholds are relative (percentile rank within this
        # dataset) rather than fixed day counts, because raw inventory
        # levels here were generated independently of demand and rarely
        # dip below ~1 week of stock in absolute terms. Ranking each SKU
        # against the others gives a meaningful, well-spread risk signal
        # regardless of the absolute unit scale.
        coverage = snap["inventory_coverage_days"]
        coverage_filled = coverage.fillna(coverage.median())
        # 0 = least coverage (most stockout-prone), 1 = most coverage (most overstocked)
        coverage_pctile = coverage_filled.rank(pct=True)

        # Independent secondary signals so the two scores aren't purely the
        # inverse of one another — a SKU can be simultaneously volatile
        # (stockout-prone) AND slow-turning (overstock-prone), landing in
        # "Watch / Volatile", or calm on both fronts, landing in "Healthy".
        volatility_pctile = snap["rolling_std_7"].fillna(0).rank(pct=True)
        turnover_pctile = snap["Sell_Through_Rate"].fillna(snap["Sell_Through_Rate"].median()).rank(pct=True)

        trend = snap["demand_trend_7"].fillna(0)
        rising = (trend > 0).astype(float)
        falling = (trend < 0).astype(float)

        stockout_risk = (
            0.55 * (1 - coverage_pctile)
            + 0.30 * volatility_pctile
            + 0.15 * rising
        )
        overstock_risk = (
            0.55 * coverage_pctile
            + 0.30 * (1 - turnover_pctile)
            + 0.15 * falling
        )

        snap["stockout_risk"] = np.clip(stockout_risk, 0, 1).round(3)
        snap["overstock_risk"] = np.clip(overstock_risk, 0, 1).round(3)

        # --- Financial impact -----------------------------------------
        # Compare on-hand stock against expected demand across the full
        # lead-time window (not a single day's forecast) so excess/shortfall
        # reflect what actually matters operationally: will this SKU run
        # out, or sit unsold, before the next replenishment arrives?
        expected_demand_over_lead_time = snap["ml_forecast"] * snap["lead_time_days"]

        excess_units = (snap["on_hand"] - expected_demand_over_lead_time).clip(lower=0)
        snap["locked_capital"] = (excess_units * snap["unit_price"]).round(2)

        stockout_units = (expected_demand_over_lead_time - snap["on_hand"]).clip(lower=0)
        snap["revenue_at_risk"] = (stockout_units * snap["unit_price"]).round(2)

        snap["value_at_stake"] = (snap["locked_capital"] + snap["revenue_at_risk"]).round(2)

        # --- Quadrant ----------------------------------------------------
        def quadrant(row):
            high_stock = row["stockout_risk"] >= 0.5
            high_over = row["overstock_risk"] >= 0.5
            if high_stock and not high_over:
                return "reorder"
            if high_over and not high_stock:
                return "markdown"
            if high_stock and high_over:
                return "watch"
            return "healthy"

        snap["quadrant"] = snap.apply(quadrant, axis=1)
        snap["quadrant_label"] = snap["quadrant"].map(QUADRANT_LABELS)

        # --- Recommendation text ----------------------------------------
        def recommend(row):
            if row["quadrant"] == "reorder":
                return "Reorder Now"
            if row["quadrant"] == "markdown":
                return "Markdown / Clear"
            if row["quadrant"] == "watch":
                return "Watch / Volatile"
            return "Healthy"

        snap["recommendation"] = snap.apply(recommend, axis=1)

        self.sku_snapshot = snap

    # -------------------------------------------------------------------
    def _build_category_trend(self):
        trend = (
            self.history.groupby([pd.Grouper(key=self.date_col, freq="W"), "Category"])[
                self.target_col
            ]
            .sum()
            .reset_index()
        )
        self.category_trend = trend

    # -------------------------------------------------------------------
    # Public query API
    # -------------------------------------------------------------------
    def overview_metrics(self):
        snap = self.sku_snapshot
        wape_baseline = float(
            100
            * (self.scored[self.target_col] - self.scored["baseline_forecast"]).abs().sum()
            / self.scored[self.target_col].abs().sum()
        )
        wape_model = float(
            100
            * (self.scored[self.target_col] - self.scored["ml_forecast"]).abs().sum()
            / self.scored[self.target_col].abs().sum()
        )

        pivot = self.category_trend.pivot(index=self.date_col, columns="Category", values=self.target_col).fillna(0)
        pivot = pivot.tail(26)  # last ~6 months of weekly data

        return {
            "total_revenue_at_risk": round(float(snap["revenue_at_risk"].sum()), 2),
            "total_locked_capital": round(float(snap["locked_capital"].sum()), 2),
            "high_stockout_count": int((snap["stockout_risk"] >= 0.5).sum()),
            "high_overstock_count": int((snap["overstock_risk"] >= 0.5).sum()),
            "total_skus": int(len(snap)),
            "wape_baseline": round(wape_baseline, 2),
            "wape_model": round(wape_model, 2),
            "accuracy_improvement_pct": round(
                100 * (wape_baseline - wape_model) / wape_baseline, 2
            ) if wape_baseline else 0.0,
            "category_trend": {
                "labels": [d.strftime("%Y-%m-%d") for d in pivot.index],
                "series": {col: pivot[col].round(0).tolist() for col in pivot.columns},
            },
        }

    def decision_matrix(self, category: str | None = None, risk_level: str | None = None):
        snap = self.sku_snapshot.copy()
        if category and category.lower() != "all":
            snap = snap[snap["Category"] == category]
        if risk_level and risk_level.lower() != "all":
            snap = snap[snap["quadrant"] == risk_level]

        cols = [
            "sku_id", self.product_col, self.store_col, "Category", "Region",
            "stockout_risk", "overstock_risk", "quadrant", "quadrant_label",
            "value_at_stake", "on_hand", "ml_forecast",
        ]
        out = snap[cols].rename(columns={
            self.product_col: "product_id",
            self.store_col: "store_id",
            "ml_forecast": "forecast",
        })
        return out.round(3).to_dict(orient="records")

    def sku_detail(self, sku_id: str):
        hist = self.history[self.history["sku_id"] == sku_id].sort_values(self.date_col)
        if hist.empty:
            return None
        scored = self.scored[self.scored["sku_id"] == sku_id].sort_values(self.date_col)
        snap_row = self.sku_snapshot[self.sku_snapshot["sku_id"] == sku_id]
        if snap_row.empty:
            return None
        snap_row = snap_row.iloc[0]

        return {
            "sku_id": sku_id,
            "product_id": str(snap_row[self.product_col]),
            "store_id": str(snap_row[self.store_col]),
            "category": str(snap_row["Category"]),
            "region": str(snap_row["Region"]),
            "dates": [d.strftime("%Y-%m-%d") for d in hist[self.date_col]],
            "actual": hist[self.target_col].round(1).tolist(),
            "forecast_dates": [d.strftime("%Y-%m-%d") for d in scored[self.date_col]],
            "baseline_forecast": scored["baseline_forecast"].round(1).tolist(),
            "ml_forecast": scored["ml_forecast"].round(1).tolist(),
            "ci_upper": scored["ci_upper"].round(1).tolist(),
            "ci_lower": scored["ci_lower"].round(1).tolist(),
            "inventory": {
                "on_hand": int(snap_row["on_hand"]),
                "on_order": int(snap_row["on_order"]),
                "lead_time_days": int(snap_row["lead_time_days"]),
                "reorder_point": float(snap_row["reorder_point"]),
                "unit_price": float(snap_row["unit_price"]),
                "coverage_days": None if pd.isna(snap_row["inventory_coverage_days"]) else float(snap_row["inventory_coverage_days"]),
            },
            "risk": {
                "stockout_risk": float(snap_row["stockout_risk"]),
                "overstock_risk": float(snap_row["overstock_risk"]),
                "quadrant": snap_row["quadrant"],
                "quadrant_label": snap_row["quadrant_label"],
                "recommendation": snap_row["recommendation"],
            },
        }

    def action_list(self, kind: str = "reorder"):
        snap = self.sku_snapshot.copy()
        if kind == "reorder":
            snap = snap[snap["quadrant"].isin(["reorder", "watch"])]
            snap = snap.sort_values(["stockout_risk", "revenue_at_risk"], ascending=False)
            cols = [
                "sku_id", self.product_col, self.store_col, "Category",
                "stockout_risk", "on_hand", "ml_forecast", "reorder_point",
                "revenue_at_risk", "recommendation",
            ]
        else:
            snap = snap[snap["quadrant"].isin(["markdown", "watch"])]
            snap = snap.sort_values(["overstock_risk", "locked_capital"], ascending=False)
            cols = [
                "sku_id", self.product_col, self.store_col, "Category",
                "overstock_risk", "on_hand", "ml_forecast", "locked_capital",
                "recommendation",
            ]

        out = snap[cols].rename(columns={
            self.product_col: "product_id",
            self.store_col: "store_id",
            "ml_forecast": "forecast",
        })
        return out.round(2).to_dict(orient="records")

    def sku_options(self):
        snap = self.sku_snapshot
        opts = snap[["sku_id", self.product_col, self.store_col, "Category"]].rename(
            columns={self.product_col: "product_id", self.store_col: "store_id"}
        )
        return opts.sort_values("sku_id").to_dict(orient="records")

    def categories(self):
        return sorted(self.sku_snapshot["Category"].unique().tolist())


# Singleton instance imported by app.py
pipeline = ForesightPipeline()
