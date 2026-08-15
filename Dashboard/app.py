"""
Project FORESIGHT — Demand & Inventory Intelligence for NorthBay Living
--------------------------------------------------------------------------
Flask entry point. All heavy lifting (feature engineering, model scoring,
risk computation) lives in pipeline.py and runs once at startup.
"""

from flask import Flask, jsonify, render_template, request

from pipeline import pipeline

app = Flask(__name__)


@app.route("/")
def index():
    return render_template(
        "index.html",
        categories=pipeline.categories(),
        sku_options=pipeline.sku_options(),
    )


@app.route("/api/overview-metrics")
def overview_metrics():
    return jsonify(pipeline.overview_metrics())


@app.route("/api/decision-matrix")
def decision_matrix():
    category = request.args.get("category")
    risk_level = request.args.get("risk_level")
    return jsonify(pipeline.decision_matrix(category=category, risk_level=risk_level))


@app.route("/api/sku/<sku_id>")
def sku_detail(sku_id):
    data = pipeline.sku_detail(sku_id)
    if data is None:
        return jsonify({"error": f"SKU '{sku_id}' not found"}), 404
    return jsonify(data)


@app.route("/api/action-list")
def action_list():
    kind = request.args.get("type", "reorder")
    if kind not in ("reorder", "markdown"):
        return jsonify({"error": "type must be 'reorder' or 'markdown'"}), 400
    return jsonify(pipeline.action_list(kind=kind))


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
