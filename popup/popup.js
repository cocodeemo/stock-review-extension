import { drawCandles, drawIntradayLine } from "../shared/chart.js";
import { fetchSinaSuggestions, fetchStockUniverse } from "../shared/market-api.js";
import { ensureDefaults, getState, saveWatchlist } from "../shared/storage.js";
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
const matchedRules = document.getElementById("matchedRules");
const missedRules = document.getElementById("missedRules");
const detailCanvas = document.getElementById("detailCanvas");
const headerStatus = document.getElementById("headerStatus");
const detailPanel = document.querySelector(".detail-panel");
const detailIntradayBtn = document.getElementById("detailIntradayBtn");
const detailDailyBtn = document.getElementById("detailDailyBtn");

let detailChartMode = "daily";
let detailIntradayData = [];
let detailCrosshairIndex = -1;
let detailRenderState = null;

function showDetailPanel() {
  detailPanel.classList.add("visible");
  // 等布局完成后重绘，避免 clientWidth 为 0
  requestAnimationFrame(() => renderDetailChart());
}

function hideDetailPanel() {
  detailPanel.classList.remove("visible");
}

detailIntradayBtn.addEventListener("click", async () => {
  detailChartMode = "intraday";
  detailIntradayBtn.classList.add("active-tab-mini");
  detailDailyBtn.classList.remove("active-tab-mini");
  await fetchDetailIntraday();
  renderDetailChart();
});

detailDailyBtn.addEventListener("click", () => {
  detailChartMode = "daily";
  detailDailyBtn.classList.add("active-tab-mini");
  detailIntradayBtn.classList.remove("active-tab-mini");
  renderDetailChart();
});

detailCanvas.addEventListener("mousemove", (event) => {
  const rect = detailCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const data = detailChartMode === "intraday" ? detailIntradayData : null;
  const state_snapshot = detailRenderState;
  if (!state_snapshot) return;
  const { history, quote, intradayData } = state_snapshot;
  const source = detailChartMode === "intraday" ? intradayData : history.slice(-45);
  if (!source.length) return;
  const barWidth = rect.width / source.length;
  detailCrosshairIndex = Math.min(Math.floor(x / barWidth), source.length - 1);
  renderDetailChart();
});

detailCanvas.addEventListener("mouseleave", () => {
  detailCrosshairIndex = -1;
  renderDetailChart();
});

function renderDetailChart() {
  const s = detailRenderState;
  if (!s) return;
  if (detailChartMode === "intraday" && s.intradayData.length) {
    const prevClose = s.quote?.prevClose || s.history.at(-2)?.close || s.history.at(-1)?.open || 0;
    drawIntradayLine(detailCanvas, s.intradayData, Number(prevClose), detailCrosshairIndex);
  } else {
    drawCandles(detailCanvas, s.history, detailCrosshairIndex);
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
  if (response?.ok && Array.isArray(response.data)) {
    s.intradayData = response.data;
  }
}

let bootstrappedRefresh = false;
let selectedCode = null;
let stockUniverse = [];
let selectedSuggestion = null;

// 排序模式：'default' | 'score' | 'change'
const SORT_MODES = ["default", "score", "change"];
const SORT_LABELS = { default: "默认", score: "得分", change: "涨跌" };
let sortMode = "default";

document.getElementById("sortBtn").addEventListener("click", () => {
  const idx = (SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length;
  sortMode = SORT_MODES[idx];
  const btn = document.getElementById("sortBtn");
  btn.textContent = SORT_LABELS[sortMode];
  btn.classList.toggle("active", sortMode !== "default");
  render();
});

document.getElementById("detailDragBar").addEventListener("click", () => {
  selectedCode = null;
  hideDetailPanel();
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");
  // force-refresh 已包含行情拉取，run-review 直接复用缓存，避免重复请求。
  const refreshRes = await chrome.runtime.sendMessage({ type: "force-refresh" });
  if (!refreshRes?.ok) {
    console.warn("[popup] force-refresh failed:", refreshRes?.error);
  }
  const reviewRes = await chrome.runtime.sendMessage({ type: "run-review-cached" });
  if (!reviewRes?.ok) {
    console.warn("[popup] run-review-cached failed:", reviewRes?.error);
  }
  await render();
  btn.classList.remove("spinning");
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
});

detailPanel.addEventListener("click", (event) => {
  if (event.target === detailPanel) {
    selectedCode = null;
    hideDetailPanel();
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
  selectedCode = code;
  showDetailPanel();
  closeSearchModal();

  await chrome.runtime.sendMessage({ type: "force-refresh" });
  await chrome.runtime.sendMessage({ type: "run-review-cached" });
  await render();
});

watchCodeInput.addEventListener("input", handleSearchInput);
watchNameInput.addEventListener("input", handleSearchInput);

const debouncedRender = debounce(render, 120);

chrome.storage.onChanged.addListener(() => {
  debouncedRender();
});

render();

async function render() {
  const state = await getState();
  applyTheme(state.settings);

  if (!bootstrappedRefresh) {
    bootstrappedRefresh = true;
    ensureDefaults().catch(() => {});
    chrome.runtime
      .sendMessage({ type: "soft-refresh" })
      .then(() => chrome.runtime.sendMessage({ type: "run-review-cached" }))
      .then(() => render())
      .catch(() => {});
  }

  const latestReport = state.reports?.latest || null;
  watchCount.textContent = `${state.watchlist.length} 只`;
  headerStatus.textContent = buildHeaderStatus(state, latestReport);

  const sortedWatchlist = sortWatchlist(state.watchlist, state, latestReport);
  watchlistCards.innerHTML = sortedWatchlist.length
    ? sortedWatchlist.map((stock) => renderWatchItem(stock, state, latestReport)).join("")
    : renderEmptyWatchlist();

  watchlistCards.querySelectorAll(".stock-card").forEach((card) => {
    card.addEventListener("click", async () => {
      if (selectedCode === card.dataset.code) {
        selectedCode = null;
        hideDetailPanel();
        await render();
      } else {
        selectedCode = card.dataset.code;
        showDetailPanel();
        await render();
      }
    });
  });

  watchlistCards.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const state = await getState();
      const [market, code] = button.dataset.delete.split(":");
      const nextWatchlist = state.watchlist.filter((item) => !(item.market === market && item.code === code));
      await saveWatchlist(nextWatchlist);
      if (selectedCode === code) {
        selectedCode = nextWatchlist[0]?.code || null;
        if (!selectedCode) {
          hideDetailPanel();
        }
      }
      await chrome.runtime.sendMessage({ type: "run-review-cached" });
      await render();
    });
  });

  renderSelectedDetail(state, latestReport);
}

function renderWatchItem(stock, state, latestReport) {
  const symbol = `${stock.market}${stock.code}`;
  const quote = state.marketCache?.quotes?.[symbol];
  const reportItem = latestReport?.ranking?.find((item) => item.code === stock.code) || null;
  const totalPossibleScore = latestReport?.totalPossibleScore ?? 0;
  const scoreValue = reportItem?.totalScore ?? "--";
  const scoreClass = getScoreClass(scoreValue, totalPossibleScore);
  const activeClass = selectedCode === stock.code ? "active" : "";
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

function renderSelectedDetail(state, latestReport) {
  const selectedStock = state.watchlist.find((item) => item.code === selectedCode) ?? null;
  if (!selectedStock) {
    selectedTitle.textContent = "请先添加自选股";
    selectedMeta.textContent = "当前还没有可复盘的股票";
    selectedScore.textContent = "-- 分";
    selectedScore.className = "score-pill";
    metricGrid.innerHTML = "";
    matchedRules.innerHTML = emptyRuleItem("暂无加分项");
    missedRules.innerHTML = emptyRuleItem("暂无减分项");
    detailRenderState = null;
    drawCandles(detailCanvas, []);
    return;
  }

  const symbol = `${selectedStock.market}${selectedStock.code}`;
  const quote = state.marketCache?.quotes?.[symbol];
  const history = state.marketCache?.histories?.[symbol] || [];
  const reportItem = latestReport?.ranking?.find((item) => item.code === selectedStock.code) || null;
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

  matchedRules.innerHTML = reportItem?.matched?.length
    ? reportItem.matched.map((item) => ruleCard(item.ruleName, item.detail, true, item.points)).join("")
    : emptyRuleItem("暂无命中加分项");

  missedRules.innerHTML = reportItem?.missed?.length
    ? reportItem.missed.map((item) => ruleCard(item.ruleName, item.detail, false, item.points)).join("")
    : emptyRuleItem("暂无未命中项");

  const prevIntradayData = detailRenderState?.intradayData || [];
  const sameStock = detailRenderState?.stock?.code === selectedStock.code;
  detailRenderState = {
    stock: selectedStock,
    history,
    quote,
    intradayData: sameStock ? prevIntradayData : []
  };
  detailCrosshairIndex = -1;
  renderDetailChart();
}

function metricCard(label, value, color = "var(--text-main)") {
  return `
    <article class="metric-card">
      <div class="label">${label}</div>
      <div class="value" style="color:${color};">${value}</div>
    </article>
  `;
}

function ruleCard(title, detail, positive, points = 0) {
  return `
    <article class="rule-item">
      <div class="title">${positive ? "+" : "-"}${Number(points || 0)} ${escapeHtml(title)}</div>
      <div class="desc">${escapeHtml(detail || "无补充说明")}</div>
    </article>
  `;
}

function emptyRuleItem(text) {
  return `<article class="rule-item"><div class="desc">${escapeHtml(text)}</div></article>`;
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

async function handleSearchInput() {
  await loadStockUniverse();
  const keyword = `${watchCodeInput.value} ${watchNameInput.value}`.trim();
  selectedSuggestion = null;

  if (!keyword) {
    renderSearchResults([]);
    return;
  }

  const normalized = keyword.replace(/\s+/g, "").toLowerCase();
  const codeKeyword = normalized.replace(/[^0-9]/g, "");
  const remoteSuggestions = await fetchSinaSuggestions(keyword).catch(() => []);
  const localSuggestions = stockUniverse
    .map((item) => ({
      ...item,
      score: getSearchScore(item, normalized, codeKeyword)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

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

function sortWatchlist(watchlist, state, latestReport) {  if (sortMode === "default") return watchlist;

  return [...watchlist].sort((a, b) => {
    if (sortMode === "score") {
      const aScore = latestReport?.ranking?.find((r) => r.code === a.code)?.totalScore ?? -Infinity;
      const bScore = latestReport?.ranking?.find((r) => r.code === b.code)?.totalScore ?? -Infinity;
      return bScore - aScore;
    }
    if (sortMode === "change") {
      const aQ = state.marketCache?.quotes?.[`${a.market}${a.code}`];
      const bQ = state.marketCache?.quotes?.[`${b.market}${b.code}`];
      const aPct = aQ ? Number(aQ.changePct || 0) : -Infinity;
      const bPct = bQ ? Number(bQ.changePct || 0) : -Infinity;
      return bPct - aPct;
    }
    return 0;
  });
}
