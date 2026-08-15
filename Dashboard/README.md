# Project FORESIGHT — Demand & Inventory Intelligence

Flask dashboard for NorthBay Living's Operations, Merchandising, and Finance
teams: stockout / overstock risk scoring, SKU-level forecasts, and
actionable reorder / markdown lists, all built on top of the trained
`retail_demand_forecasting_model.pkl` model.

## Project structure

```
foresight_flask/
│── app.py                  Flask routes + API
│── pipeline.py             Loads the model + data, scores every SKU
│── requirements.txt
│── data/
│   ├── retail_demand_forecasting_model.pkl
│   └── retail_store_inventory_cleaned.csv
│── templates/
│   └── index.html
└── static/
    ├── css/style.css
    └── js/
        ├── charts.js       Chart.js builders
        └── dashboard.js    Fetches API data, wires up the UI
```

## Setup

```bash
cd foresight_flask
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python3 app.py
```

Then open **http://127.0.0.1:5000** in your browser.

> First load takes a couple of seconds — `pipeline.py` engineers the
> time-series features, scores every SKU × Store combination once at
> startup, and caches the result in memory.

## API reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Renders the dashboard |
| GET | `/api/overview-metrics` | KPI summary + weekly category demand trend |
| GET | `/api/decision-matrix?category=&risk_level=` | All SKUs with stockout/overstock risk, quadrant, value at stake |
| GET | `/api/sku/<sku_id>` | Historical demand, baseline, ML forecast, 80% CI, inventory details for one SKU |
| GET | `/api/action-list?type=reorder|markdown` | Prioritised task list |

`sku_id` format is `<Product ID>-<Store ID>`, e.g. `P0001-S001`.

## Notes on the data

- Lead time (7 days), and the reorder-point formula are **assumed
  operational constants** — the source dataset has no supplier/lead-time
  table. Swap `DEFAULT_LEAD_TIME_DAYS` and `reorder_point` logic in
  `pipeline.py` for real values when you have them.
- Risk scores and quadrant thresholds are transparent heuristics based on
  inventory coverage (days of stock on hand vs. forecast demand) — tune
  the thresholds in `ForesightPipeline._build_sku_snapshot()` to match
  your business's actual service-level targets.
- The 80% forecast interval is a simple ±1.28σ band from the model's
  historical residual standard deviation, not a per-SKU quantile model.
