import {
  DEFAULT_ALERT_RULES,
  DEFAULT_SCORE_RULES,
  DEFAULT_SETTINGS,
  DEFAULT_WATCHLIST,
  STORAGE_KEYS
} from "./defaults.js";
import { clone, formatStockCode, normalizeMarket } from "./utils.js";

const DEFAULT_STATE = {
  [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS,
  [STORAGE_KEYS.WATCHLIST]: DEFAULT_WATCHLIST,
  [STORAGE_KEYS.ALERT_RULES]: DEFAULT_ALERT_RULES,
  [STORAGE_KEYS.SCORE_RULES]: DEFAULT_SCORE_RULES,
  [STORAGE_KEYS.CACHE]: {
    quotes: {},
    histories: {},
    quoteUpdatedAtBySymbol: {},
    historyUpdatedAtBySymbol: {},
    lastRefreshSource: null,
    lastUpdatedAt: null
  },
  [STORAGE_KEYS.REPORTS]: {
    latest: null,
    history: []
  },
  [STORAGE_KEYS.ALERT_LOGS]: [],
  [STORAGE_KEYS.LAST_ALERT_STATE]: {}
};

export async function ensureDefaults() {
  try {
    const current = await chrome.storage.local.get(null);
    const patches = {};
    for (const [key, value] of Object.entries(DEFAULT_STATE)) {
      if (current[key] === undefined) {
        patches[key] = clone(value);
      }
    }
    if (Object.keys(patches).length > 0) {
      await chrome.storage.local.set(patches);
    }
  } catch (error) {
    console.error("[storage] ensureDefaults failed:", error);
  }
  return getState();
}

export async function getState() {
  const result = await chrome.storage.local.get(DEFAULT_STATE);
  return {
    settings: { ...clone(DEFAULT_SETTINGS), ...result[STORAGE_KEYS.SETTINGS] },
    watchlist: normalizeWatchlist(result[STORAGE_KEYS.WATCHLIST] || DEFAULT_WATCHLIST),
    alertRules: clone(result[STORAGE_KEYS.ALERT_RULES] || DEFAULT_ALERT_RULES),
    scoreRules: clone(result[STORAGE_KEYS.SCORE_RULES] || DEFAULT_SCORE_RULES),
    marketCache: clone(result[STORAGE_KEYS.CACHE] || DEFAULT_STATE[STORAGE_KEYS.CACHE]),
    reports: clone(result[STORAGE_KEYS.REPORTS] || DEFAULT_STATE[STORAGE_KEYS.REPORTS]),
    alertLogs: clone(result[STORAGE_KEYS.ALERT_LOGS] || []),
    lastAlertState: clone(result[STORAGE_KEYS.LAST_ALERT_STATE] || {})
  };
}

export async function updateSettings(partial) {
  const { settings } = await getState();
  const next = { ...settings, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

export async function saveWatchlist(watchlist) {
  const normalized = normalizeWatchlist(watchlist);
  await chrome.storage.local.set({ [STORAGE_KEYS.WATCHLIST]: normalized });
  return normalized;
}

export async function saveAlertRules(alertRules) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ALERT_RULES]: clone(alertRules) });
  return alertRules;
}

export async function saveScoreRules(scoreRules) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SCORE_RULES]: clone(scoreRules) });
  return scoreRules;
}

export async function saveMarketCache(marketCache) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CACHE]: clone(marketCache) });
}

export async function saveReports(reports) {
  await chrome.storage.local.set({ [STORAGE_KEYS.REPORTS]: clone(reports) });
}

export async function saveAlertLogs(alertLogs) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ALERT_LOGS]: clone(alertLogs) });
}

export async function saveLastAlertState(lastAlertState) {
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ALERT_STATE]: clone(lastAlertState) });
}

function normalizeWatchlist(items) {
  return clone(items || []).map((item) => ({
    code: formatStockCode(item.code),
    market: normalizeMarket(item.code, item.market),
    name: item.name || item.code,
    costPrice: Number(item.costPrice || 0),
    positionQty: Number(item.positionQty || 0),
    takeProfitPrice: Number(item.takeProfitPrice || 0),
    stopLossPrice: Number(item.stopLossPrice || 0),
    note: item.note || ""
  }));
}
