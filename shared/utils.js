export function formatStockCode(input) {
  return String(input || "").trim().replace(/[^0-9]/g, "").slice(0, 6);
}

export function inferMarket(code) {
  const normalizedCode = formatStockCode(code);
  if (!normalizedCode) {
    return "sh";
  }
  if (normalizedCode.length === 5) {
    return "hk";
  }
  // 北交所股票以 8 或 92 开头（8 = 北交所，92 = 北交所新代码）
  if (/^8/.test(normalizedCode) || /^92/.test(normalizedCode)) {
    return "bj";
  }
  if (/^(5|6|9)/.test(normalizedCode) || /^11/.test(normalizedCode)) {
    return "sh";
  }
  return "sz";
}

export function normalizeMarket(code, market) {
  const normalizedCode = formatStockCode(code);
  if (!normalizedCode) {
    return market || "sh";
  }
  if (normalizedCode.length === 5) {
    return "hk";
  }
  // 北交所股票以 8 或 92 开头
  if (/^8/.test(normalizedCode) || /^92/.test(normalizedCode)) {
    return market === "hk" ? "hk" : "bj";
  }

  const inferredMarket = inferMarket(normalizedCode);
  if (!market) {
    return inferredMarket;
  }

  if (market === "hk") {
    return inferredMarket;
  }

  if (market === "sh" && /^(0|1|2|3)/.test(normalizedCode) && !/^11/.test(normalizedCode)) {
    return "sz";
  }

  if (market === "sz" && (/^(5|6|9)/.test(normalizedCode) || /^11/.test(normalizedCode))) {
    return "sh";
  }

  return market;
}

export function buildFullSymbol(code, market) {
  const normalizedCode = formatStockCode(code);
  const normalizedMarket = market || inferMarket(normalizedCode);
  return `${normalizedMarket}${normalizedCode}`;
}

export function buildEastMoneySecid(code, market) {
  const normalizedCode = formatStockCode(code);
  const normalizedMarket = market || inferMarket(normalizedCode);
  if (normalizedMarket === "sh") {
    return `1.${normalizedCode}`;
  }
  if (normalizedMarket === "hk") {
    return `116.${normalizedCode.padStart(5, "0")}`;
  }
  // 北交所与深交所共享 secid 前缀 0
  return `0.${normalizedCode}`;
}

export function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
}

export function percent(value, digits = 2) {
  return `${round(value, digits).toFixed(digits)}%`;
}

export function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function uid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatTime(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatDateTime(date = new Date()) {
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function parseTimeToDate(timeText, baseDate = new Date()) {
  const [hours = "15", minutes = "30"] = String(timeText || "15:30").split(":");
  const date = new Date(baseDate);
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date;
}

export function isWeekend(date = new Date()) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function compareByScoreDesc(a, b) {
  return (b.totalScore || 0) - (a.totalScore || 0);
}

export function debounce(fn, delay = 250) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function clone(value) {
  if (value === null || value === undefined) return value;
  // structuredClone 比 JSON.parse(JSON.stringify) 快 ~2-3x，且保留 Date/Map/Set 类型
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (_) {
      // 回退到 JSON 方式（某些环境 structuredClone 不可用或不支持函数）
    }
  }
  return JSON.parse(JSON.stringify(value));
}
