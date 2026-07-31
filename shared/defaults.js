export const STORAGE_KEYS = {
  SETTINGS: "settings",
  WATCHLIST: "watchlist",
  ALERT_RULES: "alertRules",
  SCORE_RULES: "scoreRules",
  CACHE: "marketCache",
  REPORTS: "reports",
  ALERT_LOGS: "alertLogs",
  LAST_ALERT_STATE: "lastAlertState"
};

export const ALARM_NAMES = {
  EOD_UPDATE_1510: "eod-update-1510",
  EOD_UPDATE_1615: "eod-update-1615",
  DAILY_REVIEW: "daily-review",
  POLLING: "polling-refresh",
  INTRADAY_ALERT_1450: "intraday-alert-1450",
  INTRADAY_ALERT_1610: "intraday-alert-1610"
};

export const DEFAULT_SETTINGS = {
  refreshIntervalMinutes: 15,
  reviewReminderTime: "15:30",
  reviewOnlyTradingDays: true,
  opacity: 0.94,
  compactMode: false,
  theme: "scarlet",
  hidePriceOnBlur: false,
  klineDays: 60,
  holidayOverrides: [],
  autoOpenDashboardAfterReview: false,
  quoteBoardSymbol: "sh000001",
  reviewMode: "after_close",
  intradayAlertEnabled: true,
  intradayAlertScoreThreshold: 3
};

export const CACHE_POLICY = {
  quoteTtlMs: 15 * 60 * 1000,
  quotePollingTtlMs: 15 * 60 * 1000,
  quoteRealtimeTtlMs: 2 * 60 * 1000,
  historyTtlMs: 6 * 60 * 60 * 1000,
  intradayTtlMs: 15 * 1000,
  reviewQuoteMaxAgeMs: 3 * 60 * 1000,
  requestGapMs: 220
};

export const DEFAULT_WATCHLIST = [
  {
    code: "600519",
    market: "sh",
    name: "贵州茅台",
    costPrice: 1680,
    positionQty: 100,
    takeProfitPrice: 1880,
    stopLossPrice: 1598,
    note: "白马核心仓"
  },
  {
    code: "300750",
    market: "sz",
    name: "宁德时代",
    costPrice: 218,
    positionQty: 100,
    takeProfitPrice: 248,
    stopLossPrice: 205,
    note: "观察成长股节奏"
  },
  {
    code: "159915",
    market: "sz",
    name: "创业板ETF",
    costPrice: 1.83,
    positionQty: 2000,
    takeProfitPrice: 2.05,
    stopLossPrice: 1.72,
    note: "指数观察样例"
  },
  {
    code: "00700",
    market: "hk",
    name: "腾讯控股",
    costPrice: 320,
    positionQty: 100,
    takeProfitPrice: 360,
    stopLossPrice: 298,
    note: "港股样例"
  }
];

export const DEFAULT_ALERT_RULES = [
  {
    id: "alert-ma5-break",
    name: "跌破 5 日均线",
    type: "price_below_ma",
    enabled: true,
    params: {
      period: 5
    }
  },
  {
    id: "alert-bbi-break",
    name: "跌破 BBI",
    type: "price_below_bbi",
    enabled: true,
    params: {}
  },
  {
    id: "alert-day-change",
    name: "单日涨跌幅超 5%",
    type: "daily_abs_change_pct_gte",
    enabled: true,
    params: {
      threshold: 5
    }
  },
  {
    id: "alert-volume-spike",
    name: "放量超前一日 30%",
    type: "volume_ratio_gte",
    enabled: false,
    params: {
      threshold: 1.3
    }
  },
  {
    id: "alert-stop-line",
    name: "触发止盈止损",
    type: "position_take_profit_or_stop_loss",
    enabled: true,
    params: {}
  }
];

export const DEFAULT_SCORE_RULES = [
  {
    id: "score-green-day",
    name: "今日上涨（今收>昨收）",
    type: "close_above_open",
    enabled: true,
    points: 1,
    params: {}
  },
  {
    id: "score-bbi",
    name: "不破 BBI",
    type: "price_not_below_bbi",
    enabled: true,
    points: 1,
    params: {}
  },
  {
    id: "score-no-giant-bear",
    name: "无巨量阴线",
    type: "no_giant_bearish_candle",
    enabled: true,
    points: 1,
    params: {
      lookback: 5,
      dropThreshold: 3,
      volumeRatioThreshold: 1.5
    }
  },
  {
    id: "score-trend-up",
    name: "趋势向上",
    type: "trend_up",
    enabled: true,
    points: 1,
    params: { lookback: 20, minSlopePct: 0.05, minR2: 0.3 }
  },
  {
    id: "score-kdj",
    name: "KDJ 未死叉",
    type: "kdj_not_dead_cross",
    enabled: true,
    points: 1,
    params: {}
  }
];

export const RULE_TYPES = [
  { value: "price_above_ma", label: "价格在均线上方" },
  { value: "price_below_ma", label: "价格跌破均线" },
  { value: "price_above_bbi", label: "价格在 BBI 上方" },
  { value: "price_not_below_bbi", label: "价格不破 BBI" },
  { value: "price_below_bbi", label: "价格跌破 BBI" },
  { value: "daily_change_pct_gte", label: "单日涨幅大于等于阈值" },
  { value: "daily_change_pct_lte", label: "单日跌幅大于等于阈值" },
  { value: "daily_abs_change_pct_gte", label: "单日绝对涨跌幅大于等于阈值" },
  { value: "volume_ratio_gte", label: "成交量较前日放量倍数" },
  { value: "volume_ratio_lte", label: "成交量较前日缩量倍数" },
  { value: "take_profit_hit", label: "触及止盈线" },
  { value: "stop_loss_hit", label: "触及止损线" },
  { value: "position_take_profit_or_stop_loss", label: "触及止盈或止损" },
  { value: "close_above_open", label: "今日收盘涨（今收 > 昨收）" },
  { value: "volume_up_vs_prev", label: "成交量高于前一日" },
  { value: "macd_golden_cross", label: "MACD 金叉" },
  { value: "macd_death_cross", label: "MACD 死叉" },
  { value: "no_giant_bearish_candle", label: "最近无巨量阴线" },
  { value: "trend_up", label: "收盘价趋势向上（线性回归）" },
  { value: "kdj_not_dead_cross", label: "KDJ 未死叉" }
];

export const THEME_PRESETS = {
  scarlet: {
    id: "scarlet",
    name: "经典红绿",
    accent: "#d63c36",
    accentAlt: "#14954e",
    panel: "#fffcf9",
    text: "#17191f",
    muted: "#646d7c",
    border: "#f0e4e0"
  },
  graphite: {
    id: "graphite",
    name: "石墨办公",
    accent: "#dc4534",
    accentAlt: "#1f9451",
    panel: "#f8f9fb",
    text: "#1f2329",
    muted: "#646b78",
    border: "#e3e6ec"
  },
  mist: {
    id: "mist",
    name: "淡雾隐蔽",
    accent: "#c94f40",
    accentAlt: "#16824a",
    panel: "#f4f7fa",
    text: "#171c24",
    muted: "#6e7684",
    border: "#e2e8f0"
  }
};
