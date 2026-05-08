// 后台 Service Worker 是插件的调度中枢：
// 1. 安装或启动时初始化默认数据
// 2. 创建定时扫描与每日复盘提醒闹钟
// 3. 拉取行情并执行预警规则
// 4. 生成每日评分报告并推送系统通知
import { ALARM_NAMES } from "../shared/defaults.js";
import { CACHE_POLICY } from "../shared/defaults.js";
import {
  deriveStockSnapshot,
  fetchEastMoneyHistory,
  fetchEastMoneyIntradayTrends,
  refreshMarketBundleWithCache
} from "../shared/market-api.js";
import { buildDailyReport, buildReportNotificationMessage } from "../shared/report.js";
import { evaluateAlerts, evaluateScores } from "../shared/rules.js";
import {
  ensureDefaults,
  getState,
  saveAlertLogs,
  saveLastAlertState,
  saveMarketCache,
  saveReports
} from "../shared/storage.js";
import { formatDate, isWeekend, parseTimeToDate } from "../shared/utils.js";

let refreshTask = null;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await scheduleAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await scheduleAlarms();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAMES.EOD_UPDATE_1510) {
    await refreshAndEvaluate("scheduled-1510", { forceQuotes: true, forceHistories: true, sourceLabel: "auto-15:10" });
  }

  if (alarm.name === ALARM_NAMES.EOD_UPDATE_1615) {
    await refreshAndEvaluate("scheduled-1615", { forceQuotes: true, forceHistories: true, sourceLabel: "auto-16:15" });
  }

  if (alarm.name === ALARM_NAMES.DAILY_REVIEW) {
    await runDailyReviewReminder();
  }

  if (alarm.name === ALARM_NAMES.POLLING) {
    await refreshAndEvaluate("polling", { forceQuotes: true, sourceLabel: "polling" });
  }
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.settings || changes.watchlist) {
    await scheduleAlarms();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleRuntimeMessage(message)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((error) => {
      console.error(`[sw] message "${message?.type}" failed:`, error);
      sendResponse({ ok: false, error: error.message || "unknown error" });
    });
  return true;
});

async function handleRuntimeMessage(message) {
  // 前台页面通过 runtime message 主动触发刷新、生成复盘或打开控制台页面。
  switch (message?.type) {
    case "force-refresh":
      return refreshAndEvaluate("manual", { forceQuotes: true, forceHistories: true, sourceLabel: "manual" });
    case "soft-refresh":
      return refreshAndEvaluate("foreground", { forceQuotes: true, sourceLabel: "popup-open" });
    case "run-review":
      return runDailyReviewReminder(true);
    case "run-review-cached":
      return runDailyReviewFromCache();
    case "get-stock-history":
      return fetchEastMoneyHistory(message.code, message.market, message.limit || 120);
    case "realtime-refresh": {
      const state = await getState();
      if (!state.watchlist.length) {
        return { cacheUpdated: false };
      }
      const marketCache = await refreshMarketBundleWithCache({
        watchlist: state.watchlist,
        existingCache: state.marketCache,
        historyDays: Math.max(Number(state.settings.klineDays || 60), 60),
        forceQuotes: true,
        forceHistories: false,
        quoteTtlMs: CACHE_POLICY.quoteRealtimeTtlMs,
        historyTtlMs: CACHE_POLICY.historyTtlMs
      });
      marketCache.lastRefreshSource = "realtime";
      await saveMarketCache(marketCache);
      return { cacheUpdated: true, lastUpdatedAt: marketCache.lastUpdatedAt };
    }
    case "get-intraday-trends":
      return fetchEastMoneyIntradayTrends(message.code, message.market, message.ndays || 1);
    case "open-dashboard":
      await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
      return true;
    default:
      return null;
  }
}

async function scheduleAlarms() {
  // 固定在每天 15:10 和 16:15 更新日线缓存；复盘提醒时间仍保留用户可配置。
  const { settings } = await getState();
  const reviewTime = settings.reviewReminderTime || "15:30";
  const reviewDate = parseTimeToDate(reviewTime);
  const update1510 = parseTimeToDate("15:10");
  const update1615 = parseTimeToDate("16:15");

  await chrome.alarms.clear(ALARM_NAMES.EOD_UPDATE_1510);
  await chrome.alarms.clear(ALARM_NAMES.EOD_UPDATE_1615);
  await chrome.alarms.clear(ALARM_NAMES.DAILY_REVIEW);

  await chrome.alarms.create(ALARM_NAMES.EOD_UPDATE_1510, {
    when: getNextDailyTime(update1510).getTime(),
    periodInMinutes: 24 * 60
  });

  await chrome.alarms.create(ALARM_NAMES.EOD_UPDATE_1615, {
    when: getNextDailyTime(update1615).getTime(),
    periodInMinutes: 24 * 60
  });

  const firstReviewTime = getNextDailyTime(reviewDate);

  await chrome.alarms.create(ALARM_NAMES.DAILY_REVIEW, {
    when: firstReviewTime.getTime(),
    periodInMinutes: 24 * 60
  });

  // 盘中低频轮询闹钟，间隔由用户设置 refreshIntervalMinutes 决定
  const intervalMinutes = Math.max(Number(settings.refreshIntervalMinutes) || 15, 1);
  await chrome.alarms.clear(ALARM_NAMES.POLLING);
  await chrome.alarms.create(ALARM_NAMES.POLLING, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes
  });
}

async function refreshAndEvaluate(triggerSource = "poll", options = {}) {
  // 行情轮询入口：刷新缓存 -> 构造统一快照 -> 评估预警 -> 持久化日志。
  if (refreshTask) {
    return refreshTask;
  }

  refreshTask = performRefreshAndEvaluate(triggerSource, options).finally(() => {
    refreshTask = null;
  });

  return refreshTask;
}

async function performRefreshAndEvaluate(triggerSource = "poll", options = {}) {
  const state = await getState();
  if (!state.watchlist.length) {
    return { cacheUpdated: false, alerts: [] };
  }

  const marketCache = await refreshMarketBundleWithCache({
    watchlist: state.watchlist,
    existingCache: state.marketCache,
    historyDays: Math.max(Number(state.settings.klineDays || 60), 60),
    forceQuotes: Boolean(options.forceQuotes),
    forceHistories: Boolean(options.forceHistories),
    quoteTtlMs: CACHE_POLICY.quotePollingTtlMs,
    historyTtlMs: CACHE_POLICY.historyTtlMs
  });
  marketCache.lastRefreshSource = options.sourceLabel || triggerSource;
  await saveMarketCache(marketCache);

  const snapshots = state.watchlist.map((stock) =>
    deriveStockSnapshot(stock, marketCache.quotes, marketCache.histories)
  );

  const hits = evaluateAlerts(state.alertRules, snapshots);
  const uniqueHits = dedupeTriggeredHits(hits, state.lastAlertState);

  if (uniqueHits.length > 0) {
    for (const hit of uniqueHits) {
      await notifyAlert(hit);
    }

    const logs = [
      ...uniqueHits,
      ...state.alertLogs
    ].slice(0, 100);
    await saveAlertLogs(logs);
  }

  await saveLastAlertState(buildAlertState(hits));
  return {
    cacheUpdated: true,
    alerts: uniqueHits,
    triggerSource,
    lastUpdatedAt: marketCache.lastUpdatedAt
  };
}

async function runDailyReviewReminder(force = false) {
  // 每日复盘入口：先判断是否需要跳过非交易日，再统一生成评分排名报告。
  const state = await getState();
  if (!state.watchlist.length) {
    return { skipped: true, reason: "watchlist-empty" };
  }

  if (!force && state.settings.reviewOnlyTradingDays) {
    const tradingDay = await detectTradingDay(state);
    if (!tradingDay) {
      return { skipped: true, reason: "non-trading-day" };
    }
  }

  // 复盘报告要求尽量使用最新收盘后数据，因此这里主动刷新一次缓存。
  const marketCache = await refreshMarketBundleWithCache({
    watchlist: state.watchlist,
    existingCache: state.marketCache,
    historyDays: Math.max(Number(state.settings.klineDays || 60), 60),
    forceQuotes: true,
    forceHistories: true,
    quoteTtlMs: CACHE_POLICY.reviewQuoteMaxAgeMs,
    historyTtlMs: CACHE_POLICY.historyTtlMs
  });
  marketCache.lastRefreshSource = force ? "manual-review" : "review-reminder";
  await saveMarketCache(marketCache);

  const snapshots = state.watchlist.map((stock) =>
    deriveStockSnapshot(stock, marketCache.quotes, marketCache.histories)
  );

  const scoreResults = evaluateScores(state.scoreRules, snapshots);
  const report = buildDailyReport(scoreResults, snapshots, state.scoreRules);
  const reports = {
    latest: report,
    history: [report, ...(state.reports?.history || [])].slice(0, 30)
  };
  await saveReports(reports);

  await chrome.notifications.create("daily-review-report", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon-128.png"),
    title: `每日复盘提醒 ${formatDate(new Date())}`,
    message: buildReportNotificationMessage(report),
    contextMessage: "点击插件查看完整复盘评分排名",
    priority: 2,
    requireInteraction: true
  });

  return report;
}

async function notifyAlert(hit) {
  // 单条预警触发后立即推送系统通知，通知内容尽量压缩到股票、规则、价格三个关键信息。
  await chrome.notifications.create(`alert-${hit.symbol}-${hit.ruleId}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon-128.png"),
    title: `${hit.stockName} 触发预警`,
    message: `${hit.ruleName} | 现价 ${hit.currentPrice} | 涨跌幅 ${hit.currentChangePct}%`,
    contextMessage: hit.detail,
    priority: 2
  });
}

function buildAlertState(hits) {
  return hits.reduce((state, hit) => {
    state[`${hit.symbol}:${hit.ruleId}`] = hit.triggeredAt;
    return state;
  }, {});
}

function dedupeTriggeredHits(hits, lastAlertState) {
  const today = new Date().toISOString().slice(0, 10);
  return hits.filter((hit) => {
    const key = `${hit.symbol}:${hit.ruleId}`;
    const previous = lastAlertState[key];
    if (!previous) return true;
    return previous.slice(0, 10) !== today;
  });
}

async function detectTradingDay(state) {
  // 非交易日过滤策略：
  // 1. 周末默认跳过
  // 2. holidayOverrides 支持手动覆盖
  // 3. 工作日通过上证指数最新日线日期进一步确认是否开市
  const today = formatDate(new Date());

  if (isWeekend(new Date())) {
    return state.settings.holidayOverrides.includes(today);
  }

  if (state.settings.holidayOverrides.includes(`!${today}`)) {
    return false;
  }

  try {
    const boardHistory = await fetchEastMoneyHistory("000001", "sh", 5);
    const latest = boardHistory[boardHistory.length - 1];
    return latest?.date === today;
  } catch (error) {
    console.warn("Trading day detection failed, fallback to weekday heuristic", error);
    return true;
  }
}

function getNextDailyTime(date) {
  let next = date.getTime() > Date.now()
    ? date
    : new Date(date.getTime() + 24 * 60 * 60 * 1000);
  while (isWeekend(next)) {
    next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  }
  return next;
}

async function runDailyReviewFromCache() {
  const state = await getState();
  if (!state.watchlist.length) {
    return { skipped: true, reason: "watchlist-empty" };
  }

  const snapshots = state.watchlist.map((stock) =>
    deriveStockSnapshot(stock, state.marketCache?.quotes ?? {}, state.marketCache?.histories ?? {})
  );

  const scoreResults = evaluateScores(state.scoreRules, snapshots);
  const report = buildDailyReport(scoreResults, snapshots, state.scoreRules);
  const reports = {
    latest: report,
    history: [report, ...(state.reports?.history || [])].slice(0, 30)
  };
  await saveReports(reports);
  return report;
}
