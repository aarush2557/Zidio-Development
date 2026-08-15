/* Project FORESIGHT — dashboard controller */

document.addEventListener("DOMContentLoaded", () => {
  const veil = document.getElementById("loading-veil");

  // ---------------- Tab switching ------------------------------------
  const railLinks = document.querySelectorAll(".rail-link");
  const views = document.querySelectorAll(".view");
  railLinks.forEach((link) => {
    link.addEventListener("click", () => {
      railLinks.forEach((l) => l.classList.remove("is-active"));
      views.forEach((v) => v.classList.remove("is-active"));
      link.classList.add("is-active");
      document.getElementById(`view-${link.dataset.tab}`).classList.add("is-active");
    });
  });

  // ---------------- Chart instances -----------------------------------
  const categoryChart = initCategoryTrendChart(document.getElementById("chart-category-trend"));
  const matrixChart = initMatrixChart(document.getElementById("chart-matrix"), (skuId) => {
    // jump to SKU detail tab when a bubble is clicked
    document.querySelector('.rail-link[data-tab="sku"]').click();
    document.getElementById("sku-select").value = skuId;
    loadSkuDetail(skuId);
  });
  const skuChart = initSkuChart(document.getElementById("chart-sku"));

  // ---------------- Populate static filter options ---------------------
  const categorySelect = document.getElementById("filter-category");
  window.__CATEGORIES__.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat; opt.textContent = cat;
    categorySelect.appendChild(opt);
  });

  const skuSelect = document.getElementById("sku-select");
  window.__SKU_OPTIONS__.forEach((sku) => {
    const opt = document.createElement("option");
    opt.value = sku.sku_id;
    opt.textContent = `${sku.sku_id} · ${sku.Category}`;
    skuSelect.appendChild(opt);
  });

  // ---------------- Overview -------------------------------------------
  const money = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;

  function renderKpis(m) {
    const grid = document.getElementById("kpi-grid");
    grid.innerHTML = "";
    const cards = [
      { label: "Revenue at Risk", value: money(m.total_revenue_at_risk), sub: "from potential stockouts", accent: "var(--accent-reorder)" },
      { label: "Locked Capital", value: money(m.total_locked_capital), sub: "tied up in overstock", accent: "var(--accent-markdown)" },
      { label: "High-Risk SKUs", value: `${m.high_stockout_count} / ${m.high_overstock_count}`, sub: "stockout / overstock candidates", accent: "var(--accent-watch)" },
      { label: "Forecast Accuracy", value: `${m.accuracy_improvement_pct}%`, sub: `WAPE ${m.wape_model}% vs baseline ${m.wape_baseline}%`, accent: "var(--accent-healthy)" },
    ];
    cards.forEach((c) => {
      const el = document.createElement("div");
      el.className = "kpi-card";
      el.style.setProperty("--kpi-accent", c.accent);
      el.innerHTML = `
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}</div>
        <div class="kpi-sub">${c.sub}</div>`;
      grid.appendChild(el);
    });
  }

  function loadOverview() {
    fetch("/api/overview-metrics")
      .then((r) => r.json())
      .then((m) => {
        renderKpis(m);
        updateCategoryTrendChart(categoryChart, m.category_trend);
      });
  }

  // ---------------- Decision matrix -------------------------------------
  function loadMatrix() {
    const category = document.getElementById("filter-category").value;
    const risk = document.getElementById("filter-risk").value;
    const params = new URLSearchParams({ category, risk_level: risk });
    fetch(`/api/decision-matrix?${params}`)
      .then((r) => r.json())
      .then((records) => updateMatrixChart(matrixChart, records));
  }
  document.getElementById("filter-category").addEventListener("change", loadMatrix);
  document.getElementById("filter-risk").addEventListener("change", loadMatrix);

  // ---------------- SKU detail --------------------------------------------
  function renderSkuCards(data) {
    const wrap = document.getElementById("sku-cards");
    const inv = data.inventory;
    const cards = [
      { label: "On Hand", value: inv.on_hand.toLocaleString("en-IN") },
      { label: "On Order", value: inv.on_order.toLocaleString("en-IN") },
      { label: "Lead Time", value: `${inv.lead_time_days} days` },
      { label: "Reorder Point", value: inv.reorder_point.toLocaleString("en-IN") },
      { label: "Unit Price", value: `₹${inv.unit_price.toFixed(2)}` },
    ];
    wrap.innerHTML = cards
      .map((c) => `<div class="sku-card"><div class="sku-card-label">${c.label}</div><div class="sku-card-value">${c.value}</div></div>`)
      .join("");

    const recCard = document.createElement("div");
    recCard.className = "sku-card";
    recCard.innerHTML = `
      <div class="sku-card-label">Recommendation</div>
      <div class="sku-card-value is-recommendation">
        <span class="tag tag-${data.risk.quadrant}">${data.risk.recommendation}</span>
      </div>`;
    wrap.appendChild(recCard);

    document.getElementById("sku-panel-note").textContent =
      `${data.product_id} · Store ${data.store_id} · ${data.category} · ${data.region}`;
  }

  function loadSkuDetail(skuId) {
    if (!skuId) return;
    fetch(`/api/sku/${encodeURIComponent(skuId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) return;
        renderSkuCards(data);
        updateSkuChart(skuChart, data);
      });
  }
  skuSelect.addEventListener("change", (e) => loadSkuDetail(e.target.value));

  // ---------------- Action lists -------------------------------------------
  function riskTag(quadrant, recommendation) {
    return `<span class="tag tag-${quadrant}">${recommendation}</span>`;
  }

  function renderReorderTable(rows) {
    const tbody = document.querySelector("#table-reorder tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No SKUs currently need reordering.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${r.sku_id}</td>
          <td>${r.Category}</td>
          <td>${Math.round(r.stockout_risk * 100)}%</td>
          <td>${r.on_hand}</td>
          <td>${r.forecast}</td>
          <td>${r.reorder_point}</td>
          <td>₹${Math.round(r.revenue_at_risk).toLocaleString("en-IN")}</td>
          <td>${riskTag(r.quadrant ?? "reorder", r.recommendation)}</td>
        </tr>`
      )
      .join("");
  }

  function renderMarkdownTable(rows) {
    const tbody = document.querySelector("#table-markdown tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No SKUs currently need markdown.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${r.sku_id}</td>
          <td>${r.Category}</td>
          <td>${Math.round(r.overstock_risk * 100)}%</td>
          <td>${r.on_hand}</td>
          <td>${r.forecast}</td>
          <td>₹${Math.round(r.locked_capital).toLocaleString("en-IN")}</td>
          <td>${riskTag(r.quadrant ?? "markdown", r.recommendation)}</td>
        </tr>`
      )
      .join("");
  }

  let cachedReorder = [];
  let cachedMarkdown = [];

  function loadActionLists() {
    fetch("/api/action-list?type=reorder")
      .then((r) => r.json())
      .then((rows) => { cachedReorder = rows; renderReorderTable(rows); });
    fetch("/api/action-list?type=markdown")
      .then((r) => r.json())
      .then((rows) => { cachedMarkdown = rows; renderMarkdownTable(rows); });
  }

  function exportCsv(rows, filename) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(",")].concat(
      rows.map((row) => headers.map((h) => `"${String(row[h]).replace(/"/g, '""')}"`).join(","))
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  document.querySelectorAll(".btn-export").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.export;
      if (kind === "reorder") exportCsv(cachedReorder, "reorder_recommendations.csv");
      else exportCsv(cachedMarkdown, "markdown_recommendations.csv");
    });
  });

  // ---------------- Init --------------------------------------------------
  loadOverview();
  loadMatrix();
  loadActionLists();
  if (window.__SKU_OPTIONS__.length) {
    skuSelect.value = window.__SKU_OPTIONS__[0].sku_id;
    loadSkuDetail(skuSelect.value);
  }

  veil.classList.add("is-hidden");
  setTimeout(() => veil.remove(), 400);
});
