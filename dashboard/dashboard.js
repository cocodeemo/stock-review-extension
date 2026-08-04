// Dashboard 是完整盯盘工作台，负责自选股维护、个股查看、K 线展示和报告浏览。
import { drawCandles, drawIntradayLine, intradayMouseToIndex } from "../shared/chart.js";
import { buildReportHtml, buildReportMarkdown } from "../shared/report.js";
import { ensureDefaults, getState, saveWatchlist } from "../shared/storage.js";
import { applyTheme, formatCurrency } from "../shared/ui.js";
import { debounce, escapeHtml, formatDateTime, formatStockCode, inferMarket, toNumber } from "../shared/utils.js";

const watchForm = document.getElementById("watchForm");
const watchTable = document.getElementById("watchTable");
const quoteSummary = document.getElementById("quoteSummary");
const selectedTitle = document.getElementById("selectedTitle");
const reportRanking = document.getElementById("reportRanking");
const reportTimestamp = document.getElementById("reportTimestamp");
const reportOverview = document.getElementById("reportOverview");
const alertLogs = document.getElementById("alertLogs");
const klineCanvas = document.getElementById("klineCanvas");
const liveStatus = document.getElementById("liveStatus");
const showIntradayBtn = document.getElementById("showIntradayBtn");
const showDailyBtn = document.getElementById("showDailyBtn");

let selectedCode = null;
let bootstrappedRefresh = false;
let realtimeTimer = null;
let intradayTimer = null;
let isRealtimeRefreshing = false;
let isIntradayRefreshing = false;
let intradayBySymbol = {};
let prevCloseBySymbol = {};
let chartMode = "intraday";
let crosshairIndex = -1;
let cachedState = null;

function scoreTagClass(score, totalPossible) {
  if (!totalPossible) return "up";
  const ratio = Number(score || 0) / totalPossible;
  if (ratio >= 0.6) return "score-high";
  if (ratio >= 0.3) return "score-mid";
  return "score-low";
}

document.getElementById("refreshBtn").addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "force-refresh" });
    if (res && !res.ok) {
      console.warn("[dashboard] force-refresh error:", res.error);
    }
  } catch (err) {
    console.warn("[dashboard] force-refresh failed:", err);
  }
  await refreshIntradayForSelection(true);
  await render();
});

document.getElementById("reviewBtn").addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "run-review" });
    if (res && !res.ok) {
      console.warn("[dashboard] run-review error:", res.error);
    }
  } catch (err) {
    console.warn("[dashboard] run-review failed:", err);
  }
  await render();
});

document.getElementById("exportMdBtn").addEventListener("click", async () => {
  const { reports } = await getState();
  if (!reports?.latest) {
    return;
  }
  downloadTextFile(
    `复盘报告-${reports.latest.generatedAt.slice(0, 10)}.md`,
    buildReportMarkdown(reports.latest),
    "text/markdown;charset=utf-8"
  );
});

document.getElementById("exportHtmlBtn").addEventListener("click", async () => {
  const { reports } = await getState();
  if (!reports?.latest) {
    return;
  }
  downloadTextFile(
    `复盘报告-${reports.latest.generatedAt.slice(0, 10)}.html`,
    buildReportHtml(reports.latest),
    "text/html;charset=utf-8"
  );
});

document.getElementById("optionsBtn").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

document.getElementById("toggleExtraBtn").addEventListener("click", () => {
  const extra = document.getElementById("watchFormExtra");
  const btn = document.getElementById("toggleExtraBtn");
  const isHidden = extra.classList.contains("hidden");
  extra.classList.toggle("hidden", !isHidden);
  btn.textContent = isHidden ? "- 收起" : "+ 详细信息";
});

showIntradayBtn.addEventListener("click", async () => {
  chartMode = "intraday";
  showIntradayBtn.classList.add("active-tab");
  showDailyBtn.classList.remove("active-tab");

  const selectedStock = cachedState?.watchlist.find((item) => item.code === selectedCode) || cachedState?.watchlist[0];
  const symbol = selectedStock ? `${selectedStock.market}${selectedStock.code}` : null;
  const hasCached = symbol && intradayBySymbol[symbol]?.length > 0;

  if (hasCached) {
    renderChart(cachedState);
  } else {
    liveStatus.textContent = "正在加载分时数据...";
  }

  await refreshIntradayForSelection(true);
});

showDailyBtn.addEventListener("click", async () => {
  chartMode = "daily";
  showDailyBtn.classList.add("active-tab");
  showIntradayBtn.classList.remove("active-tab");
  crosshairIndex = -1;
  await render();
});

let chartRafPending = false;
klineCanvas.addEventListener("mousemove", (event) => {
  if (!cachedState) return;
  const rect = klineCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const selectedStock = cachedState.watchlist.find((item) => item.code === selectedCode) || cachedState.watchlist[0];
  const symbol = selectedStock ? `${selectedStock.market}${selectedStock.code}` : null;
  if (!symbol) return;
  if (chartMode === "intraday") {
    const intraday = intradayBySymbol[symbol] || [];
    if (!intraday.length) return;
    crosshairIndex = intradayMouseToIndex(x, klineCanvas, intraday, selectedStock.market || "sh");
  } else {
    const history = (cachedState.marketCache?.histories?.[symbol] || []).slice(-45);
    if (!history.length) return;
    const barWidth = rect.width / history.length;
    crosshairIndex = Math.min(Math.floor(x / barWidth), history.length - 1);
  }
  if (!chartRafPending) {
    chartRafPending = true;
    requestAnimationFrame(() => {
      chartRafPending = false;
      renderChart(cachedState);
    });
  }
});

klineCanvas.addEventListener("mouseleave", () => {
  crosshairIndex = -1;
  if (cachedState) renderChart(cachedState);
});

function renderChart(state) {
  const selectedStock = state.watchlist.find((item) => item.code === selectedCode) || state.watchlist[0];
  const symbol = selectedStock ? `${selectedStock.market}${selectedStock.code}` : null;
  const quote = symbol ? state.marketCache?.quotes?.[symbol] : null;
  const history = symbol ? state.marketCache?.histories?.[symbol] || [] : [];
  const intraday = symbol ? intradayBySymbol[symbol] || [] : [];
  const market = selectedStock?.market || "sh";

  if (chartMode === "intraday" && intraday.length) {
    const prevClose = Number(prevCloseBySymbol[symbol] || quote?.prevClose || history.at(-2)?.close || history.at(-1)?.open || 0);
    drawIntradayLine(klineCanvas, intraday, prevClose, crosshairIndex, market);
    showIntradayBtn.classList.add("active-tab");
    showDailyBtn.classList.remove("active-tab");
  } else {
    drawCandles(klineCanvas, history, crosshairIndex);
    showDailyBtn.classList.add("active-tab");
    showIntradayBtn.classList.remove("active-tab");
  }
}

watchTable.addEventListener("click", async (event) => {
  const selectBtn = event.target.closest(".select-btn");
  if (selectBtn) {
    selectedCode = selectBtn.dataset.code;
    await refreshIntradayForSelection(true);
    await render();
    return;
  }
  const deleteBtn = event.target.closest(".delete-btn");
  if (deleteBtn) {
    const deleteCode = deleteBtn.dataset.code;
    const deleteMarket = deleteBtn.dataset.market;
    const st = await getState();
    const target = st.watchlist.find((item) => item.code === deleteCode && item.market === deleteMarket);
    if (!confirm(`确认删除「${target?.name || deleteCode}」？`)) return;
    const nextWatchlist = st.watchlist.filter((item) => !(item.code === deleteCode && item.market === deleteMarket));
    await saveWatchlist(nextWatchlist);
    if (selectedCode === deleteCode) {
      selectedCode = nextWatchlist[0]?.code || null;
    }
    await render();
    chrome.runtime.sendMessage({ type: "run-review-cached" }).catch(() => {});
  }
});

watchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(watchForm);
  const state = await getState();
  const code = formatStockCode(formData.get("code"));
  if (!code) {
    return;
  }

  const item = {
    code,
    market: inferMarket(code),
    name: String(formData.get("name") || code).trim(),
    costPrice: toNumber(formData.get("costPrice")),
    positionQty: toNumber(formData.get("positionQty")),
    takeProfitPrice: toNumber(formData.get("takeProfitPrice")),
    stopLossPrice: toNumber(formData.get("stopLossPrice")),
    note: String(formData.get("note") || "").trim()
  };

  const nextWatchlist = state.watchlist.filter((entry) => !(entry.code === code && entry.market === item.market));
  nextWatchlist.unshift(item);
  await saveWatchlist(nextWatchlist);
  watchForm.reset();
  selectedCode = code;
  await chrome.runtime.sendMessage({ type: "force-refresh" });
  await render();
});

chrome.storage.onChanged.addListener(() => {
  debouncedRender();
});

const debouncedRender = debounce(render, 120);

const importModal = document.getElementById("importModal");
const importTextarea = document.getElementById("importTextarea");
const importResult = document.getElementById("importResult");

document.getElementById("importBtn").addEventListener("click", () => {
  importTextarea.value = "";
  importResult.textContent = "";
  importModal.classList.remove("hidden");
  importTextarea.focus();
});

document.getElementById("importCloseBtn").addEventListener("click", () => {
  importModal.classList.add("hidden");
});

document.getElementById("importCancelBtn").addEventListener("click", () => {
  importModal.classList.add("hidden");
});

importModal.addEventListener("click", (event) => {
  if (event.target === importModal) importModal.classList.add("hidden");
});

document.getElementById("importConfirmBtn").addEventListener("click", async () => {
  const lines = importTextarea.value.split("\n").map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  const failed = [];

  for (const line of lines) {
    const parts = line.split(/[\s　,，]+/);
    let code = null;
    let name = null;

    for (const part of parts) {
      const cleaned = part.replace(/\.HK$/i, "").replace(/[^0-9]/g, "");
      if (cleaned.length >= 5 && cleaned.length <= 6) {
        code = cleaned.padStart(cleaned.length === 5 ? 5 : 6, "0");
      } else {
        name = part.replace(/\.HK$/i, "");
      }
    }

    if (!code) { failed.push(line); continue; }

    const isHk = /\.HK$/i.test(line.replace(/\s/g, "")) || code.length === 5;
    const market = isHk ? "hk" : inferMarket(code);

    parsed.push({
      code: isHk ? code.padStart(5, "0") : code.padStart(6, "0"),
      market,
      name: name || code,
      costPrice: 0, positionQty: 0, takeProfitPrice: 0, stopLossPrice: 0, note: ""
    });
  }

  if (parsed.length === 0) {
    importResult.textContent = "没有解析到有效股票，请检查格式";
    return;
  }

  const st = await getState();
  const existingKeys = new Set(st.watchlist.map((s) => `${s.market}:${s.code}`));
  const toAdd = parsed.filter((s) => !existingKeys.has(`${s.market}:${s.code}`));
  const merged = [...st.watchlist, ...toAdd];
  await saveWatchlist(merged);

  importResult.textContent = `✓ 导入 ${toAdd.length} 只，跳过重复 ${parsed.length - toAdd.length} 只${failed.length ? `，${failed.length} 行无法识别` : ""}`;
  await render();
});

document.addEventListener("visibilitychange", () => {
  restartRealtimeLoop();
});

window.addEventListener("beforeunload", () => {
  stopRealtimeLoop();
});

ensureDefaults().then(() => render()).catch((err) => {
  console.error("[dashboard] init failed:", err);
  document.body.innerHTML = '<div style="padding:2rem;text-align:center;color:#666;">初始化失败，请刷新页面重试</div>';
});

async function render() {
  // 每次重绘都按当前选中股票更新行情摘要和图表。
  const state = await getState();
  cachedState = state;
  applyTheme(state.settings);

  if (!bootstrappedRefresh) {
    bootstrappedRefresh = true;
    chrome.runtime.sendMessage({ type: "soft-refresh" }).catch((err) => console.warn("[dashboard] soft-refresh failed:", err));
    restartRealtimeLoop();
    refreshIntradayForSelection(true).catch((err) => console.warn("[dashboard] initial intraday fetch failed:", err));
  }

  if (!selectedCode && state.watchlist[0]) {
    selectedCode = state.watchlist[0].code;
  }

  watchTable.innerHTML = state.watchlist
    .map((stock) => {
      const symbol = `${stock.market}${stock.code}`;
      const quote = state.marketCache?.quotes?.[symbol];
      const hasQuote = Boolean(quote && quote.price > 0);
      return `
        <div class="watch-row" data-symbol="${escapeHtml(symbol)}">
          <div>
            <strong>${escapeHtml(stock.name)}</strong>
            <div class="muted">${escapeHtml(stock.code)} | 现价 ${hasQuote ? formatCurrency(quote.price) : "—（无数据）"}</div>
          </div>
          <div>
            <button data-code="${escapeHtml(stock.code)}" data-market="${escapeHtml(stock.market)}" class="ghost-btn select-btn">查看</button>
            <button data-code="${escapeHtml(stock.code)}" data-market="${escapeHtml(stock.market)}" class="ghost-btn delete-btn">删除</button>
          </div>
        </div>
      `;
    })
    .join("");

  const selectedStock = state.watchlist.find((item) => item.code === selectedCode) || state.watchlist[0];
  const symbol = selectedStock ? `${selectedStock.market}${selectedStock.code}` : null;
  const quote = symbol ? state.marketCache?.quotes?.[symbol] : null;
  const history = symbol ? state.marketCache?.histories?.[symbol] || [] : [];
  const quoteUpdatedAt = symbol ? state.marketCache?.quoteUpdatedAtBySymbol?.[symbol] : null;
  const intraday = symbol ? intradayBySymbol[symbol] || [] : [];
  const market = selectedStock?.market || "sh";

  selectedTitle.textContent = selectedStock
    ? `${selectedStock.name} ${selectedStock.code}`
    : "请选择一只股票";
  liveStatus.textContent = selectedStock
    ? `实时盯盘已开启 | 最新报价 ${quoteUpdatedAt ? formatDateTime(new Date(quoteUpdatedAt)) : "等待拉取"} | 轮询约 5 秒`
    : "未连接实时行情";

  quoteSummary.innerHTML = selectedStock
    ? `
        <div class="metric-card"><div class="label">现价</div><div class="value">${formatCurrency(quote?.price)}</div></div>
        <div class="metric-card"><div class="label">涨跌幅</div><div class="value" style="color:${Number(quote?.changePct) >= 0 ? "var(--accent-up)" : "var(--accent-down)"}">${Number(quote?.changePct || 0).toFixed(2)}%</div></div>
        <div class="metric-card"><div class="label">5日均线</div><div class="value">${formatCurrency(history.at(-1)?.ma5)}</div></div>
        <div class="metric-card"><div class="label">BBI</div><div class="value">${formatCurrency(history.at(-1)?.bbi)}</div></div>
        <div class="metric-card"><div class="label">持仓盈亏</div><div class="value">${formatCurrency((quote?.price - selectedStock.costPrice) * (selectedStock.positionQty || 0))}</div></div>
      `
    : "";

  if (chartMode === "intraday" && intraday.length) {
    const prevClose = Number(prevCloseBySymbol[symbol] || quote?.prevClose || history.at(-2)?.close || history.at(-1)?.open || 0);
    drawIntradayLine(klineCanvas, intraday, prevClose, crosshairIndex, market);
  } else {
    drawCandles(klineCanvas, history, crosshairIndex);
  }

  const latestReport = state.reports?.latest;
  reportTimestamp.textContent = latestReport?.generatedAtText || "未生成";
  reportOverview.innerHTML = latestReport
    ? `满分 ${latestReport.totalPossibleScore} 分 | 最高分 ${latestReport.overview.topScore} 分 | 平均分 ${latestReport.overview.avgScore} 分 | 强势标的 ${latestReport.overview.strongCount} 只 | 弱势标的 ${latestReport.overview.weakCount} 只`
    : '点击「生成复盘」后，这里会给出整组自选股的强弱分布摘要。';
  reportRanking.innerHTML = latestReport?.ranking?.length
    ? latestReport.ranking
        .map(
          (item) => `
            <div class="report-item">
              <div>
                <strong>${escapeHtml(item.rank)}. ${escapeHtml(item.name)}</strong>
                <div class="muted">${escapeHtml(item.code)} | 现价 ${formatCurrency(item.currentPrice)}</div>
              </div>
              <div>
                <div class="tag ${scoreTagClass(item.totalScore, latestReport?.totalPossibleScore)}">${escapeHtml(item.totalScore)}分</div>
                <div class="muted">${item.matched.map((rule) => escapeHtml(rule.ruleName)).join("、") || "暂无"}</div>
              </div>
            </div>
          `
        )
        .join("")
    : `<div class="alert-item"><div class="muted">点击"生成复盘"后，这里会按得分高低展示完整排名。</div></div>`;

  alertLogs.innerHTML = state.alertLogs?.length
    ? state.alertLogs
        .slice(0, 20)
        .map(
          (item) => `
            <div class="alert-item">
              <div>
                <strong>${escapeHtml(item.stockName)}</strong>
                <div class="muted">${escapeHtml(item.ruleName)}</div>
              </div>
              <div>
                <div class="tag ${Number(item.currentChangePct) >= 0 ? "up" : "down"}">${formatCurrency(item.currentPrice)}</div>
                <div class="muted">${new Date(item.triggeredAt).toLocaleString()}</div>
              </div>
            </div>
          `
        )
        .join("")
    : `<div class="alert-item"><div class="muted">最近还没有触发新的预警。</div></div>`;
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function restartRealtimeLoop() {
  stopRealtimeLoop();
  if (document.visibilityState !== "visible") {
    return;
  }

  realtimeTimer = window.setInterval(async () => {
    if (isRealtimeRefreshing) return;
    isRealtimeRefreshing = true;
    try {
      await chrome.runtime.sendMessage({ type: "realtime-refresh" });
    } catch (err) {
      console.warn("[dashboard] realtime-refresh failed:", err);
    } finally {
      isRealtimeRefreshing = false;
    }
  }, 5000);

  intradayTimer = window.setInterval(async () => {
    if (isIntradayRefreshing) return;
    isIntradayRefreshing = true;
    try {
      await refreshIntradayForSelection();
    } finally {
      isIntradayRefreshing = false;
    }
  }, 15000);
}

function stopRealtimeLoop() {
  if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
  if (intradayTimer) {
    clearInterval(intradayTimer);
    intradayTimer = null;
  }
}

async function refreshIntradayForSelection(force = false) {
  const state = await getState();
  cachedState = state;
  const selectedStock = state.watchlist.find((item) => item.code === selectedCode) || state.watchlist[0];
  if (!selectedStock) {
    return;
  }
  const symbol = `${selectedStock.market}${selectedStock.code}`;

  // 如果不是强制刷新且有缓存数据，直接使用缓存
  if (!force && intradayBySymbol[symbol]?.length > 0) {
    if (chartMode === "intraday") {
      await render();
    }
    return;
  }

  if (!force && chartMode !== "intraday") {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "get-intraday-trends",
    code: selectedStock.code,
    market: selectedStock.market,
    ndays: 1
  }).catch(() => null);

  if (response?.ok && response.data) {
    const { preClose, points } = response.data;
    if (Array.isArray(points)) {
      intradayBySymbol[symbol] = points;
      if (preClose > 0) {
        prevCloseBySymbol[symbol] = preClose;
      }
      while (Object.keys(intradayBySymbol).length > 10) {
        const oldestKey = Object.keys(intradayBySymbol)[0];
        delete intradayBySymbol[oldestKey];
        delete prevCloseBySymbol[oldestKey];
      }
    }
  }

  if (chartMode === "intraday") {
    await render();
  }
}
