import { drawCandles, drawIntradayLine, intradayMouseToIndex } from "../shared/chart.js";
import { fetchSinaSuggestions, fetchStockUniverse } from "../shared/market-api.js";
import { ensureDefaults, getState, saveWatchlist, updateSettings } from "../shared/storage.js";
import { applyTheme, renderBadge } from "../shared/ui.js";
import { formatStockCode, inferMarket, escapeHtml, debounce } from "../shared/utils.js";

const watchlistCards = document.getElementById("watchlistCards");
const watchCount = document.getElementById("watchCount");
const searchModal = document.getElementById("searchModal");
const openSearchBtn = document.getElementById("openSearchBtn");
const closeSearchBtn = document.getElementById("closeSearchBtn");
const watchForm = document.getElementById("watchForm");
const watchCodeInput = document.getElementById("watchCodeInput");
const watchNameInput = document.getElementById("watchNameInput");
const searchResults = document.getElementById("searchResults");
const selectedTitle = document.getElementById("selectedTitle");
const selectedMeta = document.getElementById("selectedMeta");
const selectedScore = document.getElementById("selectedScore");
const metricGrid = document.getElementById("metricGrid");
const detailCanvas = document.getElementById("detailCanvas");
const headerStatus = document.getElementById("headerStatus");
const detailPanel = document.querySelector(".detail-panel");
const detailBackdrop = document.getElementById("detailBackdrop");
const detailIntradayBtn = document.getElementById("detailIntradayBtn");
const detailDailyBtn = document.getElementById("detailDailyBtn");

let detailChartMode = "daily";
let detailIntradayData = [];
let detailCrosshairIndex = -1;
let detailRenderState = null;
// 当前正在异步拉取日K的股票代码，仅对同一只股票去重
let detailDailyFetchingCode = null;

function showDetailPanel() {
  if (detailBackdrop) detailBackdrop.hidden = false;
  detailPanel.classList.add("visible");
  // 图表绘制由调用方随后触发的 render() → renderSelectedDetail 统一完成，
  // 避免此处 rAF 用旧的 detailRenderState 抢先画一帧过期内容。
}

function hideDetailPanel() {
  detailPanel.classList.remove("visible");
  if (detailBackdrop) detailBackdrop.hidden = true;
}

detailIntradayBtn.addEventListener("click", async () => {
  detailChartMode = "intraday";
  detailIntradayBtn.classList.add("active-tab-mini");
  detailDailyBtn.classList.remove("active-tab-mini");
  // 先用缓存数据立即渲染，避免 UI 空白
  renderDetailChart();
  // 异步拉取最新分时数据，完成后刷新
  await fetchDetailIntraday();
  renderDetailChart();
});

detailDailyBtn.addEventListener("click", () => {
  detailChartMode = "daily";
  detailDailyBtn.classList.add("active-tab-mini");
  detailIntradayBtn.classList.remove("active-tab-mini");
  // 用 rAF 确保布局更新后再绘制
  requestAnimationFrame(() => renderDetailChart());
  // 异步拉取最新日K数据，完成后刷新（避免 6h TTL 缓存中的盘中快照缺失下影线）
  fetchDetailDaily();
});

let detailRafPending = false;
detailCanvas.addEventListener("mousemove", (event) => {
  const rect = detailCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  if (!detailRenderState) return;
  const { history, intradayData, stock } = detailRenderState;
  if (detailChartMode === "intraday") {
    if (!intradayData.length) return;
    detailCrosshairIndex = intradayMouseToIndex(x, detailCanvas, intradayData, stock?.market || "sh");
  } else {
    const dailyData = history.slice(-45);
    if (!dailyData.length) return;
    // 与 drawCandles 布局保持一致（chart.js: marginLeft=6, marginRight=58）
    const chartW = rect.width - 6 - 58;
    if (chartW <= 0) return;
    const barWidth = chartW / dailyData.length;
    detailCrosshairIndex = Math.min(Math.max(Math.floor((x - 6) / barWidth), 0), dailyData.length - 1);
  }
  if (!detailRafPending) {
    detailRafPending = true;
    requestAnimationFrame(() => {
      detailRafPending = false;
      renderDetailChart();
    });
  }
});

detailCanvas.addEventListener("mouseleave", () => {
  detailCrosshairIndex = -1;
  renderDetailChart();
});

function renderDetailChart() {
  const s = detailRenderState;
  if (!s) return;
  if (detailChartMode === "intraday" && s.intradayData.length) {
    const prevClose = Number(s.intradayPreClose || s.quote?.prevClose || s.history.at(-2)?.close || s.history.at(-1)?.open || 0);
    drawIntradayLine(detailCanvas, s.intradayData, prevClose, detailCrosshairIndex, s.stock?.market || "sh");
  } else {
    drawCandles(detailCanvas, s.history, detailCrosshairIndex);
    // 分时无数据时回退绘制日K，需同步把 tab 高亮切回日K
    if (detailChartMode === "intraday") {
      detailChartMode = "daily";
      detailDailyBtn.classList.add("active-tab-mini");
      detailIntradayBtn.classList.remove("active-tab-mini");
      // 回退到日K时也异步刷新最新数据
      fetchDetailDaily();
    }
  }
}

async function fetchDetailIntraday() {
  const s = detailRenderState;
  if (!s?.stock) return;
  const response = await chrome.runtime.sendMessage({
    type: "get-intraday-trends",
    code: s.stock.code,
    market: s.stock.market,
    ndays: 1
  }).catch(() => null);
  // 若 await 期间用户切换了股票，丢弃过期结果，避免写入已不显示的旧状态
  if (s !== detailRenderState) return;
  if (response?.ok && response.data) {
    const { preClose, points } = response.data;
    if (Array.isArray(points)) {
      s.intradayData = points;
      s.intradayPreClose = preClose > 0 ? preClose : 0;
    }
  }
}

async function fetchDetailDaily() {
  const s = detailRenderState;
  if (!s?.stock) return;
  const { code, market } = s.stock;
  // 仅对同一只股票去重，快速切换股票时新股票可并行拉取
  if (detailDailyFetchingCode === code) return;
  detailDailyFetchingCode = code;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get-stock-history",
      code,
      market,
      limit: 120
    }).catch(() => null);
    // 用股票代码而非对象引用判断：await 期间 detailRenderState 可能因
    // storage 触发 render 被重建，但只要仍是同一只股票，就写入最新数据
    const cur = detailRenderState;
    if (!cur || cur.stock?.code !== code) return;
    if (response?.ok && Array.isArray(response.data) && response.data.length) {
      cur.history = response.data;
      // 仅当前仍处于日K模式时重绘，避免覆盖分时图
      if (detailChartMode === "daily") {
        renderDetailChart();
      }
    }
  } finally {
    if (detailDailyFetchingCode === code) {
      detailDailyFetchingCode = null;
    }
  }
}

let bootstrappedRefresh = false;
let selectedCode = null;
let stockUniverse = [];
let selectedSuggestion = null;

// 排序模式：'default' | 'score' | 'score-asc' | 'change'
const SORT_MODES = ["default", "score", "score-asc", "change"];
const SORT_LABELS = { default: "默认", score: "得分↓", "score-asc": "得分↑", change: "涨跌" };
let sortMode = "default";

document.getElementById("sortBtn").addEventListener("click", async () => {
  const idx = (SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length;
  sortMode = SORT_MODES[idx];
  // 持久化排序状态，下次打开 popup 保持
  const state = await getState();
  await updateSettings({ sortMode });
  const btn = document.getElementById("sortBtn");
  btn.textContent = SORT_LABELS[sortMode];
  btn.classList.toggle("active", sortMode !== "default");
  render();
});

document.getElementById("detailDragBar").addEventListener("click", () => {
  selectedCode = null;
  hideDetailPanel();
  render();
});

// 点击悬浮卡片外的遮罩区域：退出详情
detailBackdrop?.addEventListener("click", async () => {
  selectedCode = null;
  hideDetailPanel();
  await render();
});

// Esc 键退出详情
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && detailPanel.classList.contains("visible")) {
    selectedCode = null;
    hideDetailPanel();
    render();
  }
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  if (btn.classList.contains("spinning")) return; // 并发锁：刷新进行中忽略连点
  btn.classList.add("spinning");
  // 抑制 storage.onChanged 触发的重复渲染，避免闪烁。
  // 抑制必须覆盖整个异步流程（两个消息 + 手动 render），
  // 因此从 render 完成后才开始计时，而非从点击时固定计时。
  suppressStorageRender = true;
  try {
    const refreshRes = await chrome.runtime.sendMessage({ type: "force-refresh" });
    if (!refreshRes?.ok) {
      console.warn("[popup] force-refresh failed:", refreshRes?.error);
    }
    const reviewRes = await chrome.runtime.sendMessage({ type: "run-review-cached" });
    if (!reviewRes?.ok) {
      console.warn("[popup] run-review-cached failed:", reviewRes?.error);
    }
    await render();
    // 消息与渲染均已落定，再静默一小段吸收延迟到达的 storage 事件
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    suppressStorageRender = false;
    btn.classList.remove("spinning");
  }
});

document.getElementById("openDashboardBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "open-dashboard" });
});

document.getElementById("openOptionsBtn").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

openSearchBtn.addEventListener("click", async () => {
  await loadStockUniverse();
  openSearchModal();
});

closeSearchBtn.addEventListener("click", () => {
  closeSearchModal();
});

document.getElementById("closeDetailBtn").addEventListener("click", () => {
  selectedCode = null;
  hideDetailPanel();
  render();
});

detailPanel.addEventListener("click", async (event) => {
  if (event.target === detailPanel) {
    selectedCode = null;
    hideDetailPanel();
    await render();
  }
});

searchModal.addEventListener("click", (event) => {
  if (event.target === searchModal) {
    closeSearchModal();
  }
});

watchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const state = await getState();
  const suggestion = selectedSuggestion || findExactSuggestion(watchCodeInput.value.trim(), watchNameInput.value.trim());
  if (!suggestion) {
    watchCodeInput.focus();
    return;
  }

  const { code, market, name } = suggestion;
  const existing = state.watchlist.find((item) => item.code === code && item.market === market);
  const nextItem = existing
    ? { ...existing, name }
    : {
        code,
        market,
        name
      };

  const nextWatchlist = [nextItem, ...state.watchlist.filter((item) => !(item.code === code && item.market === market))];
  await saveWatchlist(nextWatchlist);
  selectedCode = `${market}${code}`;
  showDetailPanel();
  closeSearchModal();

  await chrome.runtime.sendMessage({ type: "force-refresh" });
  await chrome.runtime.sendMessage({ type: "run-review-cached" });
  await render();
});

const debouncedSearchInput = debounce(handleSearchInput, 300);
watchCodeInput.addEventListener("input", debouncedSearchInput);
watchNameInput.addEventListener("input", debouncedSearchInput);

const debouncedRender = debounce(render, 120);
let suppressStorageRender = false;

chrome.storage.onChanged.addListener(() => {
  if (suppressStorageRender) return;
  debouncedRender();
});

render();

async function render() {
  const state = await getState();
  applyTheme(state.settings);

  // 从持久化设置恢复排序状态
  const savedSort = state.settings?.sortMode;
  if (SORT_MODES.includes(savedSort) && savedSort !== sortMode) {
    sortMode = savedSort;
    const sortBtnEl = document.getElementById("sortBtn");
    if (sortBtnEl) {
      sortBtnEl.textContent = SORT_LABELS[sortMode];
      sortBtnEl.classList.toggle("active", sortMode !== "default");
    }
  }

  if (!bootstrappedRefresh) {
    bootstrappedRefresh = true;
    ensureDefaults().catch((err) => console.warn("[popup] ensureDefaults failed:", err));
    chrome.runtime
      .sendMessage({ type: "soft-refresh" })
      .then(() => chrome.runtime.sendMessage({ type: "run-review-cached" }))
      .then(() => render())
      .catch((err) => console.warn("[popup] background refresh failed:", err));
  }

  const latestReport = state.reports?.latest || null;
  watchCount.textContent = `${state.watchlist.length} 只`;
  headerStatus.textContent = buildHeaderStatus(state, latestReport);

  // 建 ranking Map 供列表与详情复用，避免循环内线性查找
  const rankingMap = new Map();
  if (latestReport?.ranking?.length) {
    for (const item of latestReport.ranking) {
      rankingMap.set(item.code, item);
    }
  }

  const sortedWatchlist = sortWatchlist(state.watchlist, state, latestReport);
  watchlistCards.innerHTML = sortedWatchlist.length
    ? sortedWatchlist.map((stock) => renderWatchItem(stock, state, rankingMap, latestReport)).join("")
    : renderEmptyWatchlist();

  renderSelectedDetail(state, rankingMap, latestReport);
}

// 事件委托：在容器上只绑定一次，避免每次 render 重建 innerHTML 后重复绑定
watchlistCards.addEventListener("click", async (event) => {
  const deleteBtn = event.target.closest("[data-delete]");
  if (deleteBtn) {
    event.stopPropagation();
    const st = await getState();
    const [market, code] = deleteBtn.dataset.delete.split(":");
    const symbol = `${market}${code}`;
    const nextWatchlist = st.watchlist.filter((item) => !(item.market === market && item.code === code));
    await saveWatchlist(nextWatchlist);
    if (selectedCode === symbol) {
      selectedCode = nextWatchlist[0] ? `${nextWatchlist[0].market}${nextWatchlist[0].code}` : null;
      if (!selectedCode) {
        hideDetailPanel();
      }
    }
    await chrome.runtime.sendMessage({ type: "run-review-cached" });
    await render();
    return;
  }
  const card = event.target.closest(".stock-card");
  if (card) {
    if (selectedCode === card.dataset.symbol) {
      selectedCode = null;
      hideDetailPanel();
    } else {
      selectedCode = card.dataset.symbol;
      showDetailPanel();
    }
    await render();
  }
});

function renderWatchItem(stock, state, rankingMap, latestReport) {
  const symbol = `${stock.market}${stock.code}`;
  const quote = state.marketCache?.quotes?.[symbol];
  const reportItem = rankingMap.get(stock.code) || null;
  const totalPossibleScore = latestReport?.totalPossibleScore ?? 0;
  const scoreValue = reportItem?.totalScore ?? "--";
  const scoreClass = getScoreClass(scoreValue, totalPossibleScore);
  const activeClass = selectedCode === `${stock.market}${stock.code}` ? "active" : "";
  const hasQuote = Boolean(quote && quote.price > 0);
  const price = hasQuote ? Number(quote.price).toFixed(2) : "—";
  const changePct = hasQuote ? Number(quote.changePct || 0) : 0;

  return `
    <article class="stock-card ${activeClass}" data-code="${escapeHtml(stock.code)}" data-symbol="${escapeHtml(symbol)}">
      <button class="delete-btn" type="button" data-delete="${escapeHtml(stock.market)}:${escapeHtml(stock.code)}" title="删除自选股">×</button>
      <div class="stock-head">
        <div>
          <div class="stock-name">${escapeHtml(stock.name)}<span class="stock-market-tag">${stock.market === "hk" ? "港" : stock.market === "bj" ? "北" : "A"}</span></div>
          <div class="stock-code">${escapeHtml(stock.market.toUpperCase())} ${escapeHtml(stock.code)}</div>
        </div>
        <div class="stock-score ${scoreClass}">
          <span class="num">${escapeHtml(String(scoreValue))}</span>分
        </div>
      </div>
      <div class="stock-mid">
        <div class="stock-price">${price}</div>
        <div class="stock-mid-right">
          ${renderBadge(changePct)}
        </div>
      </div>
    </article>
  `;
}

function getScoreClass(score, totalPossible) {
  if (score === "--" || !totalPossible) return "up";
  const ratio = Number(score) / totalPossible;
  if (ratio >= 0.6) return "score-high";
  if (ratio >= 0.3) return "score-mid";
  return "score-low";
}

function renderSelectedDetail(state, rankingMap, latestReport) {
  const selectedStock = state.watchlist.find((item) => `${item.market}${item.code}` === selectedCode) ?? null;
  if (!selectedStock) {
    selectedTitle.textContent = "请先添加自选股";
    selectedMeta.textContent = "当前还没有可复盘的股票";
    selectedScore.textContent = "-- 分";
    selectedScore.className = "score-pill";
    metricGrid.innerHTML = "";
    detailRenderState = null;
    drawCandles(detailCanvas, []);
    return;
  }

  const symbol = `${selectedStock.market}${selectedStock.code}`;
  const quote = state.marketCache?.quotes?.[symbol];
  const prevDetail = detailRenderState;
  const sameStock =
    prevDetail?.stock?.code === selectedStock.code &&
    prevDetail?.stock?.market === selectedStock.market;
  // 若该股票已异步刷新过最新日K（含最新交易日），优先保留，
  // 避免被 6h TTL 缓存中的盘中快照覆盖导致下影线等形态缺失
  const history = pickLatestHistory(
    sameStock && prevDetail.history?.length ? prevDetail.history : [],
    state.marketCache?.histories?.[symbol] || []
  );
  const reportItem = rankingMap.get(selectedStock.code) || null;
  const totalPossibleScore = latestReport?.totalPossibleScore ?? 0;
  const hasQuote = Boolean(quote && quote.price > 0);
  const currentPrice = hasQuote ? Number(quote.price) : Number(history.at(-1)?.close || 0);
  const changePct = hasQuote ? Number(quote.changePct || 0) : Number(history.at(-1)?.changePct || 0);

  selectedTitle.textContent = `${selectedStock.name} ${selectedStock.code}`;
  selectedMeta.textContent = reportItem
    ? `复盘得分 ${reportItem.totalScore}/${totalPossibleScore} · 当前价格 ${currentPrice.toFixed(2)}${hasQuote ? "" : "（缓存）"}`
    : hasQuote
      ? "点击「刷新复盘」后自动更新评分"
      : `暂无行情数据 (symbol=${symbol})，请检查网络或重新刷新`;

  if (selectedStock.market === "hk" || selectedStock.market === "bj") {
    selectedMeta.textContent += selectedStock.market === "bj"
      ? " · 北交所行情"
      : " · 港股免费网页行情可能存在延时";
  }

  selectedScore.textContent = `${reportItem?.totalScore ?? "--"} 分`;
  selectedScore.className = `score-pill ${getScoreClass(reportItem?.totalScore ?? "--", totalPossibleScore)}`;

  metricGrid.innerHTML = `
    ${metricCard("现价", currentPrice.toFixed(2))}
    ${metricCard("涨跌幅", `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`, changePct >= 0 ? "var(--accent-up)" : "var(--accent-down)")}
    ${metricCard("MA5", Number(history.at(-1)?.ma5 || 0).toFixed(2))}
    ${metricCard("BBI", Number(history.at(-1)?.bbi || 0).toFixed(2))}
    ${metricCard("换手率", history.at(-1)?.turnoverRate ? `${Number(history.at(-1).turnoverRate).toFixed(2)}%` : "--")}
  `;

  const prevIntradayData = prevDetail?.intradayData || [];
  const prevIntradayPreClose = prevDetail?.intradayPreClose || 0;
  detailRenderState = {
    stock: selectedStock,
    history,
    quote,
    intradayData: sameStock ? prevIntradayData : [],
    intradayPreClose: sameStock ? prevIntradayPreClose : 0
  };
  detailCrosshairIndex = -1;
  renderDetailChart();
  // 打开详情/切换股票且处于日K模式时，异步拉取最新日K（避免收盘后
  // 6h TTL 缓存中的盘中快照缺失下影线等形态），in-flight 去重防重复请求
  if (detailChartMode === "daily" && !sameStock) {
    fetchDetailDaily();
  }
}

// 比较两段日K，返回包含最新交易日（最后一根日期更大）的那段，用于在
// 6h TTL 缓存与异步拉取的最新数据之间选择较新者，避免旧快照覆盖新形态
function pickLatestHistory(a, b) {
  if (!Array.isArray(a) || !a.length) return Array.isArray(b) ? b : [];
  if (!Array.isArray(b) || !b.length) return a;
  const aDate = String(a.at(-1)?.date || "");
  const bDate = String(b.at(-1)?.date || "");
  return aDate >= bDate ? a : b;
}

function metricCard(label, value, color = "var(--text-main)") {
  return `
    <article class="metric-card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value" style="color:${escapeHtml(color)};">${escapeHtml(String(value))}</div>
    </article>
  `;
}

function buildHeaderStatus(state, latestReport) {
  const updatedAt = state.marketCache?.lastUpdatedAt;
  const source = state.marketCache?.lastRefreshSource;

  const sourceLabel =
    source === "manual" ? "手动刷新"
    : source === "auto-15:10" ? "15:10 自动"
    : source === "auto-16:15" ? "16:15 自动"
    : source === "manual-review" || source === "review-reminder" ? "复盘触发"
    : source === "popup-open" ? "打开触发"
    : "缓存";

  const reviewText = latestReport
    ? `复盘 ${latestReport.generatedAtText}`
    : "未复盘";

  if (!updatedAt) {
    return `${reviewText} · 15:10 / 16:15 自动`;
  }

  return `${reviewText} · 行情 ${sourceLabel}`;
}

async function loadStockUniverse() {
  if (stockUniverse.length) {
    return stockUniverse;
  }
  try {
    stockUniverse = await fetchStockUniverse();
  } catch (error) {
    console.error("Failed to load stock universe", error);
    stockUniverse = [];
  }
  return stockUniverse;
}

let searchSeq = 0;
async function handleSearchInput() {
  await loadStockUniverse();
  const keyword = `${watchCodeInput.value} ${watchNameInput.value}`.trim();
  const seq = ++searchSeq;
  selectedSuggestion = null;

  if (!keyword) {
    renderSearchResults([]);
    return;
  }

  const normalized = keyword.replace(/\s+/g, "").toLowerCase();
  const codeKeyword = normalized.replace(/[^0-9]/g, "");
  const remoteSuggestions = await fetchSinaSuggestions(keyword).catch(() => []);
  // 丢弃过期请求结果，避免旧关键字覆盖新结果
  if (seq !== searchSeq) return;
  const localSuggestions = stockUniverse
    .map((item) => ({
      ...item,
      score: getSearchScore(item, normalized, codeKeyword)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

  if (seq !== searchSeq) return;
  const merged = mergeSuggestions(remoteSuggestions, localSuggestions).slice(0, 8);
  renderSearchResults(merged);
}

function renderSearchResults(items) {
  searchResults.innerHTML = items
    .map(
      (item) => `
        <div class="search-item" data-code="${escapeHtml(item.code)}" data-market="${escapeHtml(item.market)}" data-name="${escapeHtml(item.name)}">
          <div>
            <div class="search-name">${escapeHtml(item.name)}</div>
            <div class="search-meta">${escapeHtml(item.market.toUpperCase())} ${escapeHtml(item.code)}</div>
          </div>
          <div class="search-meta">点击选择</div>
        </div>
      `
    )
    .join("");

  searchResults.querySelectorAll(".search-item").forEach((node) => {
    node.addEventListener("click", () => {
      selectedSuggestion = {
        code: node.dataset.code,
        market: node.dataset.market,
        name: node.dataset.name
      };
      watchCodeInput.value = selectedSuggestion.code;
      watchNameInput.value = selectedSuggestion.name;
      renderSearchResults([]);
    });
  });
}

function findExactSuggestion(codeInput, nameInput) {
  const code = formatStockCode(codeInput);
  const name = nameInput.trim();

  if (selectedSuggestion) {
    return selectedSuggestion;
  }

  if (code) {
    return (
      stockUniverse.find((item) => item.code === code && item.market === inferMarket(code)) ||
      stockUniverse.find((item) => item.code === code) ||
      null
    );
  }

  if (name) {
    return stockUniverse.find((item) => item.name === name) || null;
  }

  return null;
}

function getSearchScore(item, normalizedKeyword, codeKeyword) {
  const itemCode = item.code.toLowerCase();
  const itemName = item.name.toLowerCase();
  let score = 0;

  if (codeKeyword) {
    if (itemCode === codeKeyword) {
      score += 120;
    } else if (itemCode.startsWith(codeKeyword)) {
      score += 90;
    } else if (itemCode.includes(codeKeyword)) {
      score += 50;
    }
  }

  if (normalizedKeyword) {
    if (itemName === normalizedKeyword) {
      score += 110;
    } else if (itemName.startsWith(normalizedKeyword)) {
      score += 80;
    } else if (itemName.includes(normalizedKeyword)) {
      score += 45;
    }
  }

  if (item.market === "sh" || item.market === "sz") {
    score += 3;
  }

  return score;
}

function mergeSuggestions(remoteSuggestions, localSuggestions) {
  const result = [];
  const seen = new Set();

  remoteSuggestions.forEach((item, index) => {
    const key = `${item.market}:${item.code}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push({
      ...item,
      score: 1000 - index
    });
  });

  localSuggestions.forEach((item) => {
    const key = `${item.market}:${item.code}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(item);
  });

  return result.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function openSearchModal() {
  searchModal.classList.remove("hidden");
  watchCodeInput.focus();
}

function closeSearchModal() {
  searchModal.classList.add("hidden");
  watchForm.reset();
  selectedSuggestion = null;
  renderSearchResults([]);
}

function renderEmptyWatchlist() {
  return `
    <div class="empty-watchlist">
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>
      </svg>
      <p>还没有自选股</p>
      <span>点击「添加股票」开始复盘</span>
    </div>
  `;
}

function sortWatchlist(watchlist, state, latestReport) {
  if (sortMode === "default") return watchlist;

  if (sortMode === "score" || sortMode === "score-asc") {
    const scoreMap = new Map();
    if (latestReport?.ranking) {
      for (const r of latestReport.ranking) {
        scoreMap.set(r.code, r.totalScore ?? -Infinity);
      }
    }
    return [...watchlist].sort((a, b) => {
      const aScore = scoreMap.get(a.code) ?? -Infinity;
      const bScore = scoreMap.get(b.code) ?? -Infinity;
      return sortMode === "score-asc" ? aScore - bScore : bScore - aScore;
    });
  }
  if (sortMode === "change") {
    return [...watchlist].sort((a, b) => {
      const aQ = state.marketCache?.quotes?.[`${a.market}${a.code}`];
      const bQ = state.marketCache?.quotes?.[`${b.market}${b.code}`];
      const aPct = aQ ? Number(aQ.changePct || 0) : -Infinity;
      const bPct = bQ ? Number(bQ.changePct || 0) : -Infinity;
      return bPct - aPct;
    });
  }
  return watchlist;
}
