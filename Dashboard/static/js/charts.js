/* Project FORESIGHT — chart builders (Chart.js) */

const COLORS = {
  text: "#EDF1FA",
  muted: "#8A96B3",
  faint: "#5D6A8C",
  border: "#263255",
  grid: "rgba(38, 50, 85, 0.55)",
  reorder: "#FF6B5E",
  watch: "#F2B84B",
  healthy: "#2FBF9F",
  markdown: "#8B7CF6",
  actual: "#EDF1FA",
  baseline: "#5D6A8C",
  forecast: "#2FBF9F",
  ci: "rgba(47, 191, 159, 0.14)",
};

const QUADRANT_COLOR = {
  reorder: COLORS.reorder,
  watch: COLORS.watch,
  healthy: COLORS.healthy,
  markdown: COLORS.markdown,
};

Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.color = COLORS.muted;

const CATEGORY_PALETTE = ["#2FBF9F", "#8B7CF6", "#F2B84B", "#FF6B5E", "#4FA0FF", "#F27EC0"];

function initCategoryTrendChart(ctx) {
  return new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 16, font: { size: 11.5 } },
        },
        tooltip: {
          backgroundColor: "#1B2540",
          borderColor: COLORS.border,
          borderWidth: 1,
          padding: 10,
          titleFont: { family: "'IBM Plex Mono', monospace", size: 11 },
          bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
        },
      },
      scales: {
        x: { grid: { color: COLORS.grid }, ticks: { font: { size: 10.5 }, maxRotation: 0 } },
        y: { grid: { color: COLORS.grid }, ticks: { font: { size: 10.5 } }, beginAtZero: true },
      },
    },
  });
}

function updateCategoryTrendChart(chart, payload) {
  const categories = Object.keys(payload.series);
  chart.data.labels = payload.labels;
  chart.data.datasets = categories.map((cat, i) => ({
    label: cat,
    data: payload.series[cat],
    borderColor: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
    backgroundColor: "transparent",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.3,
  }));
  chart.update();
}

function initMatrixChart(ctx, onPointClick) {
  const chart = new Chart(ctx, {
    type: "bubble",
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const el = elements[0];
        const point = chart.data.datasets[el.datasetIndex].data[el.index];
        if (point && point.sku_id && onPointClick) onPointClick(point.sku_id);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1B2540",
          borderColor: COLORS.border,
          borderWidth: 1,
          padding: 10,
          titleFont: { family: "'IBM Plex Mono', monospace", size: 11.5 },
          bodyFont: { family: "'Inter', sans-serif", size: 11.5 },
          callbacks: {
            title: (items) => items[0].raw.sku_id,
            label: (item) => {
              const p = item.raw;
              return [
                `Quadrant: ${p.quadrant_label}`,
                `Stockout risk: ${(p.x * 100).toFixed(0)}%`,
                `Overstock risk: ${(p.y * 100).toFixed(0)}%`,
                `Value at stake: ₹${Math.round(p.value_at_stake).toLocaleString("en-IN")}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Overstock Risk →", color: COLORS.faint, font: { size: 11.5 } },
          min: 0, max: 1,
          grid: { color: COLORS.grid },
          ticks: { callback: (v) => `${Math.round(v * 100)}%`, font: { size: 10.5 } },
        },
        y: {
          title: { display: true, text: "Stockout Risk →", color: COLORS.faint, font: { size: 11.5 } },
          min: 0, max: 1,
          grid: { color: COLORS.grid },
          ticks: { callback: (v) => `${Math.round(v * 100)}%`, font: { size: 10.5 } },
        },
      },
    },
    plugins: [
      {
        // faint quadrant backdrop, drawn once before the bubbles
        id: "quadrantBackdrop",
        beforeDatasetsDraw(chartInstance) {
          const { ctx, chartArea, scales } = chartInstance;
          if (!chartArea) return;
          const midX = scales.x.getPixelForValue(0.5);
          const midY = scales.y.getPixelForValue(0.5);
          ctx.save();
          ctx.fillStyle = "rgba(255,107,94,0.035)";
          ctx.fillRect(chartArea.left, chartArea.top, midX - chartArea.left, midY - chartArea.top);
          ctx.fillStyle = "rgba(242,184,75,0.035)";
          ctx.fillRect(midX, chartArea.top, chartArea.right - midX, midY - chartArea.top);
          ctx.fillStyle = "rgba(47,191,159,0.035)";
          ctx.fillRect(chartArea.left, midY, midX - chartArea.left, chartArea.bottom - midY);
          ctx.fillStyle = "rgba(139,124,246,0.035)";
          ctx.fillRect(midX, midY, chartArea.right - midX, chartArea.bottom - midY);
          ctx.strokeStyle = COLORS.border;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(midX, chartArea.top); ctx.lineTo(midX, chartArea.bottom);
          ctx.moveTo(chartArea.left, midY); ctx.lineTo(chartArea.right, midY);
          ctx.stroke();
          ctx.restore();
        },
      },
    ],
  });
  return chart;
}

function updateMatrixChart(chart, records) {
  const maxValue = Math.max(1, ...records.map((r) => r.value_at_stake || 0));
  const byQuadrant = { reorder: [], watch: [], healthy: [], markdown: [] };
  records.forEach((r) => {
    const radius = 4 + 14 * Math.sqrt((r.value_at_stake || 0) / maxValue);
    byQuadrant[r.quadrant]?.push({
      x: r.overstock_risk,
      y: r.stockout_risk,
      r: radius,
      sku_id: r.sku_id,
      quadrant_label: r.quadrant_label,
      value_at_stake: r.value_at_stake,
    });
  });

  chart.data.datasets = Object.entries(byQuadrant).map(([q, data]) => ({
    label: q,
    data,
    backgroundColor: hexToRgba(QUADRANT_COLOR[q], 0.55),
    borderColor: QUADRANT_COLOR[q],
    borderWidth: 1.5,
    hoverBackgroundColor: hexToRgba(QUADRANT_COLOR[q], 0.85),
  }));
  chart.update();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function initSkuChart(ctx) {
  return new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 16, font: { size: 11.5 } },
        },
        tooltip: {
          backgroundColor: "#1B2540",
          borderColor: COLORS.border,
          borderWidth: 1,
          padding: 10,
          bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
        },
      },
      scales: {
        x: { grid: { color: COLORS.grid }, ticks: { font: { size: 10 }, maxTicksLimit: 12 } },
        y: { grid: { color: COLORS.grid }, ticks: { font: { size: 10.5 } }, beginAtZero: true },
      },
    },
  });
}

function updateSkuChart(chart, data) {
  chart.data.labels = data.dates;

  const forecastOffset = data.dates.length - data.forecast_dates.length;
  const pad = (arr) => Array(forecastOffset).fill(null).concat(arr);

  chart.data.datasets = [
    {
      label: "Actual demand",
      data: data.actual,
      borderColor: COLORS.actual,
      backgroundColor: "transparent",
      borderWidth: 1.75,
      pointRadius: 0,
      tension: 0.15,
      order: 1,
    },
    {
      label: "Baseline (naive)",
      data: pad(data.baseline_forecast),
      borderColor: COLORS.baseline,
      backgroundColor: "transparent",
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      tension: 0.15,
      order: 2,
    },
    {
      label: "ML forecast",
      data: pad(data.ml_forecast),
      borderColor: COLORS.forecast,
      backgroundColor: "transparent",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.15,
      order: 0,
    },
    {
      label: "80% interval (upper)",
      data: pad(data.ci_upper),
      borderColor: "transparent",
      backgroundColor: COLORS.ci,
      pointRadius: 0,
      fill: "+1",
      tension: 0.15,
      order: 3,
    },
    {
      label: "80% interval (lower)",
      data: pad(data.ci_lower),
      borderColor: "transparent",
      backgroundColor: COLORS.ci,
      pointRadius: 0,
      fill: false,
      tension: 0.15,
      order: 4,
    },
  ];
  chart.update();
}
