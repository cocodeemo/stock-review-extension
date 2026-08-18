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
import { formatDate, isWeekend, parseTimeToDate, buildFullSymbol } from "../shared/utils.js";

let refreshTask = null;
let refreshTaskOptions = null;
// 预警通知内存级去重表（key: symbol:ruleId, value: 上次推送时间戳）
const recentAlertNotified = new Map();
// 全局互斥：串行化所有"读缓存→刷新→写缓存"操作，
// 避免轮询/复盘/盘中预警/实时刷新并发时基于过期快照互相覆盖 marketCache
// 注意：临界区内禁止再次调用本函数（会自死锁）
let cacheRefreshQueue = Promise.resolve();

async function refreshMarketCache(options = {}) {
  const prev = cacheRefreshQueue;
  let release;
  cacheRefreshQueue = new Promise((resolve) => { release = resolve; });
  await prev;
  try {
    const state = await getState();
    if (!state.watchlist.length) {
      return { cache: state.marketCache, state };
    }
    const marketCache = await refreshMarketBundleWithCache({
      watchlist: state.watchlist,
      existingCache: state.marketCache,
      historyDays: Math.max(Number(state.settings.klineDays || 60), 60),
      forceQuotes: Boolean(options.forceQuotes),
      forceHistories: Boolean(options.forceHistories),
      quoteTtlMs: options.quoteTtlMs ?? CACHE_POLICY.quotePollingTtlMs,
      historyTtlMs: CACHE_POLICY.historyTtlMs
    });
    marketCache.lastRefreshSource = options.sourceLabel || "scheduled";
    await saveMarketCache(marketCache);
    return { cache: marketCache, state };
  } finally {
    release();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await scheduleAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await scheduleAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  return handleAlarm(alarm);
});

async function handleAlarm(alarm) {
  try {
    if (alarm.name === ALARM_NAMES.EOD_UPDATE_1510) {
      await refreshAndEvaluate("scheduled-1510", { forceQuotes: true, forceHistories: true, quoteTtlMs: 0, sourceLabel: "auto-15:10" });
    } else if (alarm.name === ALARM_NAMES.EOD_UPDATE_1615) {
      await refreshAndEvaluate("scheduled-1615", { forceQuotes: true, forceHistories: true, quoteTtlMs: 0, sourceLabel: "auto-16:15" });
    } else if (alarm.name === ALARM_NAMES.DAILY_REVIEW) {
      await runDailyReviewReminder();
    } else if (alarm.name === ALARM_NAMES.POLLING) {
      // 非交易时段跳过轮询，避免夜间/周末每 15 分钟无效唤醒与请求；
      // 用户打开 popup/dashboard 时会主动触发刷新，不依赖后台轮询保活
      const pollingState = await getState();
      if (!isTradingSession(pollingState)) return;
      await refreshAndEvaluate("polling", { forceQuotes: true, sourceLabel: "polling" });
    } else if (alarm.name === ALARM_NAMES.INTRADAY_ALERT_1450) {
      await runIntradayScoreAlert();
    } else if (alarm.name === ALARM_NAMES.INTRADAY_ALERT_1610) {
      await runIntradayScoreAlert();
    }
  } catch (error) {
    console.error(`[sw] alarm "${alarm?.name}" failed:`, error);
  } finally {
    // 无论成功或失败，都要重新调度一次性闹钟，否则次日不再触发
    try {
      if (alarm.name === ALARM_NAMES.EOD_UPDATE_1510) {
        await rescheduleDailyAlarm(ALARM_NAMES.EOD_UPDATE_1510, "15:10");
      } else if (alarm.name === ALARM_NAMES.EOD_UPDATE_1615) {
        await rescheduleDailyAlarm(ALARM_NAMES.EOD_UPDATE_1615, "16:15");
      } else if (alarm.name === ALARM_NAMES.DAILY_REVIEW) {
        const { settings } = await getState();
        await rescheduleDailyAlarm(ALARM_NAMES.DAILY_REVIEW, settings.reviewReminderTime || "15:30");
      } else if (alarm.name === ALARM_NAMES.INTRADAY_ALERT_1450) {
        await rescheduleDailyAlarm(ALARM_NAMES.INTRADAY_ALERT_1450, "14:50");
      } else if (alarm.name === ALARM_NAMES.INTRADAY_ALERT_1610) {
        await rescheduleDailyAlarm(ALARM_NAMES.INTRADAY_ALERT_1610, "16:10");
      }
    } catch (rescheduleErr) {
      console.error(`[sw] reschedule for "${alarm?.name}" failed:`, rescheduleErr);
    }
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  // 仅当与闹钟调度相关的设置字段变更时才重新调度
  const alarmRelatedKeys = ["refreshIntervalMinutes", "reviewReminderTime", "intradayAlertEnabled"];
  if (changes.settings) {
    const oldSettings = changes.settings.oldValue || {};
    const newSettings = changes.settings.newValue || {};
    const hasAlarmChange = alarmRelatedKeys.some(
      (key) => JSON.stringify(oldSettings[key]) !== JSON.stringify(newSettings[key])
    );
    if (hasAlarmChange) {
      return scheduleAlarms();
    }
  }
  // watchlist 变更时也重新调度，确保新增股票纳入轮询范围
  // (scheduleAlarms 本身不读 watchlist，但保留了此触发点以便未来扩展)
  if (changes.watchlist) {
    return scheduleAlarms();
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
      return refreshAndEvaluate("manual", { forceQuotes: true, forceHistories: true, quoteTtlMs: 0, sourceLabel: "manual" });
    case "soft-refresh":
      return refreshAndEvaluate("foreground", { forceQuotes: true, quoteTtlMs: CACHE_POLICY.quoteRealtimeTtlMs, sourceLabel: "popup-open" });
    case "run-review":
      return runDailyReviewReminder(true);
    case "run-review-cached":
      return runDailyReviewFromCache();
    case "test-intraday-alert":
      return runIntradayScoreAlert();
    case "get-stock-history":
      return fetchEastMoneyHistory(message.code, message.market, message.limit || 120);
    case "realtime-refresh": {
      const { cache: marketCache, state: refreshState } = await refreshMarketCache({
        // 不强制刷新：让 quoteRealtimeTtlMs(2min) 生效，
        // 避免 Dashboard 每 5 秒轮询时对全部自选股重复发请求
        forceQuotes: false,
        forceHistories: false,
        quoteTtlMs: CACHE_POLICY.quoteRealtimeTtlMs,
        sourceLabel: "realtime"
      });
      if (!refreshState.watchlist.length) {
        return { cacheUpdated: false };
      }
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

  await Promise.all([
    chrome.alarms.clear(ALARM_NAMES.EOD_UPDATE_1510),
    chrome.alarms.clear(ALARM_NAMES.EOD_UPDATE_1615),
    chrome.alarms.clear(ALARM_NAMES.DAILY_REVIEW),
    chrome.alarms.clear(ALARM_NAMES.INTRADAY_ALERT_1450),
    chrome.alarms.clear(ALARM_NAMES.INTRADAY_ALERT_1610)
  ]);

  await chrome.alarms.create(ALARM_NAMES.EOD_UPDATE_1510, {
    when: getNextDailyTime(update1510).getTime()
  });

  await chrome.alarms.create(ALARM_NAMES.EOD_UPDATE_1615, {
    when: getNextDailyTime(update1615).getTime()
  });

  const firstReviewTime = getNextDailyTime(reviewDate);

  await chrome.alarms.create(ALARM_NAMES.DAILY_REVIEW, {
    when: firstReviewTime.getTime()
  });

  // 盘中低频轮询闹钟，间隔由用户设置 refreshIntervalMinutes 决定
  const intervalMinutes = Math.max(Number(settings.refreshIntervalMinutes) || 15, 1);
  await chrome.alarms.clear(ALARM_NAMES.POLLING);
  await chrome.alarms.create(ALARM_NAMES.POLLING, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes
  });

  // 盘中低分提醒：14:50（A股收盘前）和 16:10（港股收盘后）
  if (settings.intradayAlertEnabled) {
    const alert1450 = parseTimeToDate("14:50");
    const alert1610 = parseTimeToDate("16:10");
    await chrome.alarms.create(ALARM_NAMES.INTRADAY_ALERT_1450, {
      when: getNextDailyTime(alert1450).getTime()
    });
    await chrome.alarms.create(ALARM_NAMES.INTRADAY_ALERT_1610, {
      when: getNextDailyTime(alert1610).getTime()
    });
  }
}

async function rescheduleDailyAlarm(alarmName, hhmm) {
  const next = getNextDailyTime(parseTimeToDate(hhmm));
  await chrome.alarms.create(alarmName, { when: next.getTime() });
}

async function refreshAndEvaluate(triggerSource = "poll", options = {}) {
  // 行情轮询入口：刷新缓存 -> 构造统一快照 -> 评估预警 -> 持久化日志。
  // 若 in-flight 任务缺少调用方要求的 force 标志，则在其完成后再跑一遍 force，
  // 否则强制刷新会被静默吞掉。
  if (refreshTask) {
    const inFlight = refreshTaskOptions || {};
    const needsForceQuotes = options.forceQuotes && !inFlight.forceQuotes;
    const needsForceHistories = options.forceHistories && !inFlight.forceHistories;
    if (!needsForceQuotes && !needsForceHistories) {
      return refreshTask;
    }
    try {
      await refreshTask;
    } catch (_) {
      // 上一次失败由其自身的 catch 链处理；这里不阻断 force 重跑。
    }
  }

  refreshTaskOptions = options;
  refreshTask = performRefreshAndEvaluate(triggerSource, options).finally(() => {
    refreshTask = null;
    refreshTaskOptions = null;
  });

  return refreshTask;
}

async function performRefreshAndEvaluate(triggerSource = "poll", options = {}) {
  const { cache: marketCache, state } = await refreshMarketCache({
    forceQuotes: options.forceQuotes,
    forceHistories: options.forceHistories,
    quoteTtlMs: options.quoteTtlMs,
    sourceLabel: options.sourceLabel || triggerSource
  });
  if (!state.watchlist.length) {
    return { cacheUpdated: false, alerts: [] };
  }

  const snapshots = state.watchlist.map((stock) =>
    deriveStockSnapshot(stock, marketCache.quotes, marketCache.histories)
  );

  const hits = evaluateAlerts(state.alertRules, snapshots);
  const uniqueHits = dedupeTriggeredHits(hits, state.lastAlertState);

  if (uniqueHits.length > 0) {
    await Promise.all(uniqueHits.map((hit) => notifyAlert(hit)));

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

  const today = formatDate(new Date());

  // 判断今天是否为交易日，用于数据新鲜度校验（周末/节假日无新数据属正常）
  let tradingToday = true;
  if (!force && state.settings.reviewOnlyTradingDays) {
    tradingToday = await detectTradingDay(state);
    if (!tradingToday) {
      return { skipped: true, reason: "non-trading-day" };
    }
  } else if (!force) {
    try {
      tradingToday = await detectTradingDay(state);
    } catch (_) {
      tradingToday = true;
    }
  }

  // 复盘报告要求尽量使用最新收盘后数据，因此这里主动刷新一次缓存。
  const { cache: marketCache, state: freshState } = await refreshMarketCache({
    forceQuotes: true,
    forceHistories: true,
    quoteTtlMs: CACHE_POLICY.reviewQuoteMaxAgeMs,
    sourceLabel: force ? "manual-review" : "review-reminder"
  });

  // 数据新鲜度校验：统计最新日K日期不是今天的股票。
  // 刷新失败（东财→腾讯→新浪全部失败）时会静默回退旧缓存，此时打分基于旧数据，
  // 必须在发通知前识别出来，避免把昨天/更早的数据当成今日复盘结果推送。
  // 注意：quote.date 恒为当天，无法用于判断，以 histories 最后一根的真实K线日期为准。
  const staleStocks = [];
  for (const stock of freshState.watchlist) {
    const symbol = buildFullSymbol(stock.code, stock.market);
    const hist = marketCache.histories[symbol];
    const latestDate = hist && hist.length ? hist[hist.length - 1].date : null;
    if (latestDate && latestDate !== today) {
      staleStocks.push({ name: stock.name || stock.code, code: stock.code, latestDate });
    }
  }
  const staleCount = staleStocks.length;
  const allStale = freshState.watchlist.length > 0 && staleCount === freshState.watchlist.length;
  const dataStale = tradingToday && staleCount > 0;

  // 定时通知且全部股票数据过期：不发旧数据打分通知，避免误导；
  // 手动生成复盘（force）时仍生成，但会在通知中明确标注数据延迟。
  if (dataStale && allStale && !force) {
    console.warn(
      `[sw] review skipped: all data stale (${staleCount}/${freshState.watchlist.length}) today=${today}`,
      staleStocks
    );
    return { skipped: true, reason: "stale-data", staleStocks };
  }

  const snapshots = freshState.watchlist.map((stock) =>
    deriveStockSnapshot(stock, marketCache.quotes, marketCache.histories)
  );

  const scoreResults = evaluateScores(freshState.scoreRules, snapshots);
  const report = buildDailyReport(scoreResults, snapshots, freshState.scoreRules);
  const reports = {
    latest: report,
    history: [report, ...(freshState.reports?.history || [])].slice(0, 30)
  };
  await saveReports(reports);

  // 部分股票数据过期时，通知明确标注，避免被误认为今日完整数据
  const staleSuffix = dataStale ? `（${staleCount}只数据延迟）` : "";
  const latestStaleDate = staleStocks.length ? staleStocks[0].latestDate : null;
  await chrome.notifications.create("daily-review-report", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon-128.png"),
    title: `每日复盘提醒 ${today}`,
    message: buildReportNotificationMessage(report) + staleSuffix,
    contextMessage: dataStale
      ? `${staleCount}只股票数据延迟（最新 ${latestStaleDate || "—"}），请手动刷新后再看`
      : "点击插件查看完整复盘评分排名",
    priority: 2,
    requireInteraction: true
  });

  return report;
}

async function notifyAlert(hit) {
  // 内存级去重兜底：即使并发任务都通过了 lastAlertState 检查，也避免在短窗口内重复推送同一条预警
  const notifKey = `${hit.symbol}:${hit.ruleId}`;
  const now = Date.now();
  const last = recentAlertNotified.get(notifKey);
  if (last && now - last < 120000) {
    return;
  }
  recentAlertNotified.set(notifKey, now);
  if (recentAlertNotified.size > 200) {
    for (const [k, t] of recentAlertNotified) {
      if (now - t >= 120000) recentAlertNotified.delete(k);
    }
  }
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
  const today = formatDate(new Date());
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

function isTradingSession(state) {
  // 本地零网络判断当前是否处于可交易时段，用于轮询守卫：
  // 1. holidayOverrides 支持手动覆盖（!date 强制非交易日，date 强制补班交易日）
  // 2. 周末默认跳过
  // 3. 覆盖 A股(9:30-15:00) 与 港股(9:30-16:00) 交易时段，留少量余量
  const now = new Date();
  const today = formatDate(now);
  const overrides = state.settings.holidayOverrides || [];
  if (overrides.includes(`!${today}`)) return false;
  if (!overrides.includes(today) && isWeekend(now)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 16 * 60 + 30;
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

async function runIntradayScoreAlert() {
  const state = await getState();
  if (!state.watchlist.length) return { skipped: true, reason: "watchlist-empty" };
  if (!state.settings.intradayAlertEnabled) return { skipped: true, reason: "disabled" };

  if (state.settings.reviewOnlyTradingDays) {
    const tradingDay = await detectTradingDay(state);
    if (!tradingDay) return { skipped: true, reason: "non-trading-day" };
  }

  const { cache: marketCache, state: freshState } = await refreshMarketCache({
    forceQuotes: true,
    forceHistories: false,
    quoteTtlMs: CACHE_POLICY.reviewQuoteMaxAgeMs,
    sourceLabel: "intraday-alert"
  });

  const snapshots = freshState.watchlist.map((stock) =>
    deriveStockSnapshot(stock, marketCache.quotes, marketCache.histories)
  );

  const scoreResults = evaluateScores(freshState.scoreRules, snapshots);
  const threshold = Number(freshState.settings.intradayAlertScoreThreshold ?? 3);
  const lowScoreItems = scoreResults.filter((r) => (r.totalScore ?? 0) <= threshold);

  if (!lowScoreItems.length) return { skipped: true, reason: "no-low-score" };

  const now = new Date();
  const timeLabel = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  const stocks = lowScoreItems.map((r) => ({ name: r.name, score: r.totalScore }));

  const url = chrome.runtime.getURL(
    `alert-popup/alert-popup.html?time=${encodeURIComponent(timeLabel)}&threshold=${threshold}&stocks=${encodeURIComponent(JSON.stringify(stocks))}`
  );

  // 窗口高度根据股票数量自适应：标题区 ~90px + 每条 ~42px + 底部留白 16px
  const windowHeight = Math.min(110 + lowScoreItems.length * 42 + 16, 500);
  const screen = await chrome.system.display.getInfo();
  // 优先使用主显示器（getInfo 数组顺序不保证主屏在前）
  const primary = screen.find((d) => d.isPrimary) || screen[0];
  const display = primary?.workArea ?? { top: 0, left: 0, width: 1920, height: 1080 };
  await chrome.windows.create({
    url,
    type: "popup",
    width: 340,
    height: windowHeight,
    left: display.left + display.width - 360,
    top: display.top + 20,
    focused: true
  });

  return { alerted: lowScoreItems.length };
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
