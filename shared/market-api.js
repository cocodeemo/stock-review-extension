// 行情接口层统一封装免费数据源：
// - 东方财富个股接口负责最新报价
// - 东方财富 K 线接口负责历史日线
// - 新浪 hq.sinajs.cn 作为实时报价兜底（东财 push2his 不可达时自动切换）
// 这样 A 股和港股都能走同一条更新链路
import { CACHE_POLICY } from "./defaults.js";
import { attachIndicators } from "./indicators.js";
import {
  buildEastMoneySecid,
  buildFullSymbol,
  formatDate,
  formatStockCode,
  inferMarket,
  round,
  toNumber
} from "./utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 从最新 K 线数据构造 quote 对象的工厂函数
function buildQuoteFromKline(item, latest, klineData, market, symbol) {
  const price = latest.close;
  // 优先用前一根 K 线的 close 作为昨收（更可靠），其次用 price - change 反推
  const prevCandle = klineData && klineData.length >= 2 ? klineData[klineData.length - 2] : null;
  const prevClose = prevCandle && prevCandle.close > 0
    ? round(prevCandle.close, 2)
    : round(price - (latest.change ?? 0), 2);
  const change = latest.change ?? round(price - prevClose, 2);
  const changePct = latest.changePct ?? (prevClose > 0 ? round((price - prevClose) / prevClose * 100, 2) : 0);
  return {
    symbol,
    code: market === "hk"
      ? String(item.code).padStart(5, "0")
      : String(item.code).padStart(6, "0"),
    market,
    name: item.name || item.code,
    open: latest.open || 0,
    prevClose,
    price,
    high: latest.high || 0,
    low: latest.low || 0,
    volume: latest.volume || 0,
    turnover: 0,
    change,
    changePct,
    date: formatDate(),
    time: new Date().toTimeString().slice(0, 8),
    fetchedAt: new Date().toISOString()
  };
}

/**
 * 新浪实时报价兜底：从 hq.sinajs.cn 批量获取 A 股 / 港股实时报价。
 * 当东财 push2his 接口不可达时自动启用，保证价格和涨跌幅能正常显示。
 */
export async function fetchSinaQuotes(watchlist) {
  if (!watchlist.length) {
    return {};
  }

  // 构造新浪符号列表：sh600519, sz000001, hk00700
  const items = watchlist.map((item) => {
    const market = item.market || inferMarket(item.code);
    const code = market === "hk"
      ? String(item.code).padStart(5, "0")
      : String(item.code).padStart(6, "0");
    return {
      sinaSymbol: `${market}${code}`,
      fullSymbol: buildFullSymbol(item.code, market),
      item,
      market
    };
  });

  // 新浪支持一次批量请求多只股票，用逗号分隔
  const url = `https://hq.sinajs.cn/list=${items.map((i) => i.sinaSymbol).join(",")}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Referer: "https://finance.sina.com.cn/" }
    });
  } catch (err) {
    console.error("[sina-quotes] fetch failed", err);
    return {};
  }

  if (!response.ok) {
    console.warn(`[sina-quotes] HTTP ${response.status}`);
    return {};
  }

  const buffer = await response.arrayBuffer();
  const raw = new TextDecoder("gbk").decode(buffer);
  const result = {};

  for (const { sinaSymbol, fullSymbol, item, market } of items) {
    const regex = new RegExp(`var hq_str_${sinaSymbol}="([^"]*)"`);
    const match = raw.match(regex);
    if (!match || !match[1]) {
      continue;
    }

    const parts = match[1].split(",");
    if (parts.length < 4) {
      continue;
    }

    let name, open, prevClose, price, high, low, volume, turnover, date, time;

    if (market === "hk") {
      // 港股格式: ename,name,open,prevClose,price,high,low,volume,amount,...,date,time
      name = parts[1] || item.name || item.code;
      open = toNumber(parts[2]);
      prevClose = toNumber(parts[3]);
      price = toNumber(parts[4]);
      high = toNumber(parts[5]);
      low = toNumber(parts[6]);
      volume = toNumber(parts[7]);
      turnover = toNumber(parts[8]);
      // 兼容新浪港股实际返回：日期为 YYYY/MM/DD（可能连字符），时间为 HH:MM（可能带秒）
      const datePart = parts.find((p) => /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(p));
      const timePart = parts.find((p) => /^\d{2}:\d{2}(:\d{2})?$/.test(p));
      date = datePart ? datePart.replace(/\//g, "-") : formatDate();
      time = timePart
        ? (timePart.length === 5 ? `${timePart}:00` : timePart)
        : new Date().toTimeString().slice(0, 8);
    } else {
      // A 股格式: name,open,prevClose,price,high,low,bid1,ask1,volume,amount,...,date,time
      name = parts[0] || item.name || item.code;
      open = toNumber(parts[1]);
      prevClose = toNumber(parts[2]);
      price = toNumber(parts[3]);
      high = toNumber(parts[4]);
      low = toNumber(parts[5]);
      // 新浪 A 股成交量单位为“股”，换算为“手”(÷100)，与东财日K(f56,手)对齐，
      // 保证量比/量增等规则的 volume 口径一致
      volume = toNumber(parts[8]) / 100;
      turnover = toNumber(parts[9]);
      date = parts[30] || formatDate();
      time = parts[31] || new Date().toTimeString().slice(0, 8);
    }

    if (price > 0) {
      const change = round(price - prevClose, 3);
      const changePct = prevClose > 0 ? round((change / prevClose) * 100, 2) : 0;

      result[fullSymbol] = {
        symbol: fullSymbol,
        code: market === "hk"
          ? String(item.code).padStart(5, "0")
          : String(item.code).padStart(6, "0"),
        market,
        name,
        open,
        prevClose,
        price,
        high,
        low,
        volume,
        turnover,
        change,
        changePct,
        date,
        time,
        fetchedAt: new Date().toISOString()
      };
    }
  }

  console.log(`[sina-quotes] done, ${Object.keys(result).length}/${watchlist.length} ok`);
  return result;
}

export async function fetchStockUniverse() {
  // 拉取 A股 + 港股 基础列表，用于本地搜索补全，避免每次输入都打搜索接口。
  const fields = "f12,f13,f14";
  const aShareFs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
  const hkFs = "m:116+t:3";
  const bseFs = "m:0+t:81";

  // 单源失败不应拖垮整个股票池：每个市场单独容错，失败返回空数组
  const [aShareList, hkList, bseList] = await Promise.all([
    fetchClistPage(aShareFs, fields, 1, 6000).catch(() => []),
    fetchClistPage(hkFs, fields, 1, 4000).catch(() => []),
    fetchClistPage(bseFs, fields, 1, 8000).catch(() => [])
  ]);

  return [...aShareList, ...hkList, ...bseList]
    .map((item) => {
      const market = normalizeUniverseMarket(item.f13, item.f12);
      if (!market) {
        return null;
      }

      return {
        code: normalizeUniverseCode(item.f12, market),
        market,
        name: item.f14 || item.f12
      };
    })
    .filter(Boolean);
}

export async function fetchSinaSuggestions(keyword) {
  const text = String(keyword || "").trim();
  if (!text) {
    return [];
  }

  try {
    const url = `https://suggest3.sinajs.cn/suggest/key=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) {
      return [];
    }
    const buffer = await response.arrayBuffer();
    const raw = new TextDecoder("gbk").decode(buffer);
    const match = raw.match(/"([^"]*)"/);
    const payload = match?.[1] || "";
    if (!payload) {
      return [];
    }

    return payload
      .split(";")
      .map((item) => item.split(","))
      .filter((parts) => parts.length >= 4)
      .map((parts) => {
        const name = parts[0]?.trim();
        const marketCode = parts[3]?.trim() || "";
        const code = marketCode.replace(/^[a-z_]+/i, "").trim();
        const market = normalizeSuggestMarket(marketCode, code);
        if (!name || !code || !market) {
          return null;
        }
        return {
          code: market === "hk" ? code.padStart(5, "0") : code.padStart(6, "0"),
          market,
          name,
          source: "sina"
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error("[sina-suggest] fetch failed:", error);
    return [];
  }
}

function parseEastMoneyKlines(klines) {
  return klines.map((row) => {
    const [
      date,
      open,
      close,
      high,
      low,
      volume,
      turnover,
      amplitude,
      changePct,
      change,
      turnoverRate
    ] = row.split(",");

    return {
      date,
      open: toNumber(open),
      close: toNumber(close),
      high: toNumber(high),
      low: toNumber(low),
      volume: toNumber(volume),
      turnover: toNumber(turnover),
      amplitude: toNumber(amplitude),
      changePct: toNumber(changePct),
      change: toNumber(change),
      turnoverRate: toNumber(turnoverRate)
    };
  });
}

// 腾讯日K兜底源：web.ifzq.gtimg.cn，A股/港股均支持。
// 返回 [date, open, close, high, low, volume]，成交量单位为“股”，统一换算为“手”(÷100)与东财口径对齐。
// A 股前复权数据在 qfqday 字段，港股在 day 字段。
async function fetchTencentHistory(code, market, limit = 120) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 120)));
  const normalizedMarket = market || inferMarket(code);
  const normalizedCode = formatStockCode(code);
  const prefix = normalizedMarket === "hk" ? "hk" : normalizedMarket; // sh / sz / bj
  const symbol = `${prefix}${normalizedCode}`;
  const url =
    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get" +
    `?param=${symbol},day,,,${safeLimit},qfq`;

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastErr = new Error(`Tencent kline HTTP ${response.status} for ${symbol}`);
      } else {
        const payload = await response.json();
        const node = payload?.data?.[symbol];
        const rows = node?.qfqday || node?.day || [];
        return rows
          .filter((r) => Array.isArray(r) && r[0])
          .map((r) => ({
            date: r[0],
            open: toNumber(r[1]),
            close: toNumber(r[2]),
            high: toNumber(r[3]),
            low: toNumber(r[4]),
            volume: toNumber(r[5]) / 100,
            turnover: 0,
            amplitude: 0,
            changePct: 0,
            change: 0,
            turnoverRate: 0
          }));
      }
    } catch (error) {
      lastErr = error;
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastErr || new Error(`Tencent kline failed for ${symbol}`);
}

export async function fetchEastMoneyHistory(code, market, limit = 120) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 120)));
  // 使用东财日 K 数据补齐均线、BBI、MACD 所需的历史数据。
  const secid = buildEastMoneySecid(code, market);
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
    `?secid=${secid}` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&klt=101&fqt=1" +
    `&lmt=${safeLimit}&end=20500101` +
    "&ut=fa5fd1943c7b386f172d6893dbfba10b";

  // 瞬时网络抖动/限流时重试一次，避免偶发 Failed to fetch 导致详情日K缺失
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(url);
      if (response.ok) break;
      lastError = new Error(`EastMoney kline HTTP ${response.status} for ${secid}`);
    } catch (error) {
      lastError = error;
      // 记录底层网络错误码，便于在 SW console 里定位失败原因
      console.warn(
        `[market-api] EastMoney kline fetch attempt ${attempt + 1}/2 failed for ${secid}:`,
        error?.cause?.code || error?.cause?.message || error.message
      );
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  if (response && response.ok) {
    const payload = await response.json();
    const klines = payload?.data?.klines || [];
    return attachIndicators(parseEastMoneyKlines(klines));
  }

  // 东财不可达时回退到腾讯日K，避免详情页/复盘链路因单一数据源故障而中断
  try {
    const tencentCandles = await fetchTencentHistory(code, market, safeLimit);
    if (tencentCandles.length) {
      console.warn(
        `[market-api] EastMoney kline unavailable (${secid}), Tencent fallback ${tencentCandles.length} bars`
      );
      return attachIndicators(tencentCandles);
    }
    throw new Error(`Tencent fallback empty for ${secid}`);
  } catch (fallbackErr) {
    console.error(
      `[market-api] Tencent fallback failed for ${secid}:`,
      fallbackErr?.cause?.code || fallbackErr?.cause?.message || fallbackErr.message
    );
    throw lastError || new Error(`EastMoney kline failed for ${secid}`);
  }
}

export async function fetchEastMoneyIntradayTrends(code, market, ndays = 1) {
  // 分时图使用单独接口，保证实时轮询时不重复拉整段历史日 K。
  const secid = buildEastMoneySecid(code, market);
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/trends2/get" +
    `?secid=${secid}` +
    "&fields1=f1,f2,f3,f4,f5,f6,f7,f8" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58" +
    "&iscr=0" +
    "&ndays=" + ndays +
    "&ut=fa5fd1943c7b386f172d6893dbfba10b";

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`EastMoney intraday HTTP ${response.status} for ${secid}`);
  }
  const payload = await response.json();
  const trends = payload?.data?.trends || [];
  const preClose = toNumber(payload?.data?.preClose);

  const parsed = trends.map((row) => {
    // 东财 trends2 返回 8 个字段: f51(时间) f52(最新价) f53(均价) f54(最高) f55(最低) f56(成交量-累计手) f57(成交额-累计) f58(均价2)
    const parts = row.split(",");
    return {
      time: parts[0],
      price: toNumber(parts[1]),
      avgPrice: toNumber(parts[2]),
      volume: toNumber(parts[5]),   // f56: 累计成交量（手）
      amount: toNumber(parts[6])    // f57: 累计成交额
    };
  });

  // volume 是累计值，转成每分钟增量；首点保留原始累计值（开盘集合竞价量）
  const points = parsed.map((item, index) => ({
    ...item,
    volume: index === 0 ? item.volume : Math.max(item.volume - parsed[index - 1].volume, 0)
  }));

  return { preClose, points };
}

export async function refreshMarketBundleWithCache({
  watchlist,
  existingCache,
  historyDays = 120,
  forceQuotes = false,
  forceHistories = false,
  quoteTtlMs = CACHE_POLICY.quoteTtlMs,
  historyTtlMs = CACHE_POLICY.historyTtlMs
}) {
  // 分层缓存策略：
  // 1. 实时行情单次批量拉取，短 TTL
  // 2. 历史日线按股票长 TTL 缓存
  // 3. 请求失败时优先回退旧缓存，避免整个插件数据直接清空
  const cache = normalizeMarketCache(existingCache);
  const quotes = { ...cache.quotes };
  const histories = { ...cache.histories };
  const quoteUpdatedAtBySymbol = { ...cache.quoteUpdatedAtBySymbol };
  const historyUpdatedAtBySymbol = { ...cache.historyUpdatedAtBySymbol };

  // 缓存 key 迁移：当 watchlist 的 market 修正后（如 sz→bj），将旧 key 数据移到新 key。
  // 通过遍历现有缓存 key 来定位，避免遗漏（例如港股 code 长度不一致导致拼接结果不同）。
  const correctSymbolByCode = new Map();
  for (const item of watchlist) {
    correctSymbolByCode.set(formatStockCode(item.code), {
      symbol: buildFullSymbol(item.code, item.market),
      market: item.market
    });
  }
  const migrateMap = (target, updatedAt) => {
    for (const oldSymbol of Object.keys(target)) {
      const match = oldSymbol.match(/^([a-z]+)(\d+)$/);
      if (!match) {
        delete target[oldSymbol];
        if (updatedAt) delete updatedAt[oldSymbol];
        continue;
      }
      const codePart = formatStockCode(match[2]);
      const entry = correctSymbolByCode.get(codePart);
      if (!entry) {
        // watchlist 中已不存在的 code，丢弃孤儿缓存。
        delete target[oldSymbol];
        if (updatedAt) delete updatedAt[oldSymbol];
        continue;
      }
      if (oldSymbol === entry.symbol) {
        continue;
      }
      if (!target[entry.symbol]) {
        const value = target[oldSymbol];
        target[entry.symbol] = typeof value === "object" && !Array.isArray(value)
          ? { ...value, symbol: entry.symbol, market: entry.market }
          : value;
        if (updatedAt && updatedAt[oldSymbol]) {
          updatedAt[entry.symbol] = updatedAt[oldSymbol];
        }
      }
      delete target[oldSymbol];
      if (updatedAt) delete updatedAt[oldSymbol];
    }
  };
  migrateMap(quotes, quoteUpdatedAtBySymbol);
  migrateMap(histories, historyUpdatedAtBySymbol);

  const symbols = watchlist.map((item) => buildFullSymbol(item.code, item.market));
  const now = Date.now();

  // 先拉 history（长TTL 6h），行情单独走实时K线请求（短TTL），互不依赖
  const staleHistoryItems = watchlist.filter((item) => {
    const symbol = buildFullSymbol(item.code, item.market);
    return forceHistories || isExpired(historyUpdatedAtBySymbol[symbol], historyTtlMs, now) || !histories[symbol]?.length;
  });

  // 分批并行拉取历史数据，每批 5 只，批间等待一个请求间隔
  const BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < staleHistoryItems.length; batchStart += BATCH_SIZE) {
    const batch = staleHistoryItems.slice(batchStart, batchStart + BATCH_SIZE);
    await Promise.all(
      batch.map(async (item) => {
        const symbol = buildFullSymbol(item.code, item.market);
        try {
          const freshHistory = await fetchEastMoneyHistory(item.code, item.market || inferMarket(item.code), historyDays);
          histories[symbol] = freshHistory;
          historyUpdatedAtBySymbol[symbol] = new Date().toISOString();
        } catch (error) {
          console.warn(`History refresh failed for ${symbol}, fallback to cached history`, error);
        }
      })
    );
    if (batchStart + BATCH_SIZE < staleHistoryItems.length) {
      await sleep(CACHE_POLICY.requestGapMs * BATCH_SIZE);
    }
  }

  // 行情刷新：拉取最新1条K线获取实时报价（不从history缓存提取，避免history 6h TTL内行情不更新）
  // forceQuotes=true 时强制刷新全部（等价于 quoteTtlMs=0）；否则按 quoteTtlMs 过期检查
  const effectiveQuoteTtl = forceQuotes ? 0 : quoteTtlMs;
  const staleQuoteSymbols = watchlist
    .map((item) => buildFullSymbol(item.code, item.market))
    .filter((symbol) => isExpired(quoteUpdatedAtBySymbol[symbol], effectiveQuoteTtl, now));

  const staleQuoteSet = new Set(staleQuoteSymbols);
  const staleQuoteItems = watchlist.filter((item) =>
    staleQuoteSet.has(buildFullSymbol(item.code, item.market))
  );

  for (let batchStart = 0; batchStart < staleQuoteItems.length; batchStart += BATCH_SIZE) {
    const batch = staleQuoteItems.slice(batchStart, batchStart + BATCH_SIZE);
    await Promise.all(
      batch.map(async (item) => {
        const symbol = buildFullSymbol(item.code, item.market);
        const market = item.market || inferMarket(item.code);
        try {
          const freshKline = await fetchEastMoneyHistory(item.code, market, 1);
          const latest = freshKline && freshKline.length > 0 ? freshKline[freshKline.length - 1] : null;
          if (latest && latest.close > 0) {
            quotes[symbol] = buildQuoteFromKline(item, latest, freshKline, market, symbol);
            quoteUpdatedAtBySymbol[symbol] = new Date().toISOString();
          }
        } catch (error) {
          console.warn(`[quote-refresh] failed for ${symbol}, using cached quote`, error);
          // 请求失败时保留旧缓存行情，不清空
        }
      })
    );
    if (batchStart + BATCH_SIZE < staleQuoteItems.length) {
      await sleep(CACHE_POLICY.requestGapMs * BATCH_SIZE);
    }
  }

  // 如果还有 symbol 没有 quote（history 缓存仍为空），单独拉 1 条 kline 作兜底
  // 直接调 fetchEastMoneyHistory 拉取最新1条K线获取实时报价
  const missingQuoteItems = watchlist.filter((item) => {
    const symbol = buildFullSymbol(item.code, item.market);
    return !quotes[symbol] || !quotes[symbol].price;
  });

  if (missingQuoteItems.length > 0) {
    await Promise.all(
      missingQuoteItems.map(async (item) => {
        const symbol = buildFullSymbol(item.code, item.market);
        const market = item.market || inferMarket(item.code);
        try {
          const klineData = await fetchEastMoneyHistory(item.code, market, 1);
          const latest = klineData && klineData.length > 0 ? klineData[klineData.length - 1] : null;
          if (latest && latest.close > 0) {
            quotes[symbol] = buildQuoteFromKline(item, latest, klineData, market, symbol);
            quoteUpdatedAtBySymbol[symbol] = new Date().toISOString();
          }
        } catch (error) {
          console.warn(`Fallback quote fetch failed for ${symbol}`, error);
        }
      })
    );
  }

  // 最终兜底：东财 kline 仍然失败的股票，用新浪批量取实时报价
  const stillMissingItems = watchlist.filter((item) => {
    const symbol = buildFullSymbol(item.code, item.market);
    return !quotes[symbol] || !quotes[symbol].price;
  });

  if (stillMissingItems.length > 0) {
    console.log(`[bundle] ${stillMissingItems.length} quotes still missing, trying Sina fallback...`);
    try {
      const sinaQuotes = await fetchSinaQuotes(stillMissingItems);
      for (const [symbol, quote] of Object.entries(sinaQuotes)) {
        quotes[symbol] = quote;
        quoteUpdatedAtBySymbol[symbol] = new Date().toISOString();
      }
    } catch (err) {
      console.warn("[bundle] Sina fallback failed", err);
    }
  }

  return {
    quotes,
    histories,
    quoteUpdatedAtBySymbol,
    historyUpdatedAtBySymbol,
    lastRefreshSource: forceHistories || forceQuotes ? "manual_or_forced" : "scheduled",
    lastUpdatedAt: new Date().toISOString()
  };
}

export function getCacheFreshness(cache, symbol) {
  const normalizedCache = normalizeMarketCache(cache);
  return {
    quoteUpdatedAt: normalizedCache.quoteUpdatedAtBySymbol[symbol] || null,
    historyUpdatedAt: normalizedCache.historyUpdatedAtBySymbol[symbol] || null
  };
}

function normalizeMarketCache(cache) {
  return {
    quotes: cache?.quotes || {},
    histories: cache?.histories || {},
    quoteUpdatedAtBySymbol: cache?.quoteUpdatedAtBySymbol || {},
    historyUpdatedAtBySymbol: cache?.historyUpdatedAtBySymbol || {},
    lastRefreshSource: cache?.lastRefreshSource || null,
    lastUpdatedAt: cache?.lastUpdatedAt || null
  };
}

async function fetchClistPage(fs, fields, pn = 1, pz = 2000) {
  const url =
    "https://push2.eastmoney.com/api/qt/clist/get" +
    `?pn=${pn}` +
    `&pz=${pz}` +
    "&po=1&np=1&fltt=2&invt=2&fid=f3" +
    `&fs=${encodeURIComponent(fs)}` +
    `&fields=${fields}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`EastMoney clist HTTP ${response.status}`);
  }
  const payload = await response.json();
  return payload?.data?.diff || [];
}

function normalizeUniverseMarket(f13, code) {
  if (String(f13) === "1") {
    return "sh";
  }
  if (String(f13) === "0") {
    // f13=0 可能是深市也可能是北交所，需结合代码判断
    const normalizedCode = String(code || "").trim();
    if (/^8/.test(normalizedCode) || /^92/.test(normalizedCode)) {
      return "bj";
    }
    return "sz";
  }
  if (String(f13) === "116" || String(code || "").length === 5) {
    return "hk";
  }
  return null;
}

function normalizeUniverseCode(code, market) {
  const text = String(code || "").trim();
  return market === "hk" ? text.padStart(5, "0") : text.padStart(6, "0");
}

function normalizeSuggestMarket(symbolText, code) {
  const symbol = String(symbolText || "").toLowerCase();
  if (symbol.startsWith("sh")) {
    return "sh";
  }
  if (symbol.startsWith("sz")) {
    return "sz";
  }
  if (symbol.startsWith("hk")) {
    return "hk";
  }
  if (symbol.startsWith("bj")) {
    return "bj";
  }
  if (String(code || "").length === 5) {
    return "hk";
  }
  // 北交所代码以 8 或 92 开头
  const normalizedCode = String(code || "").trim();
  if (/^8/.test(normalizedCode) || /^92/.test(normalizedCode)) {
    return "bj";
  }
  return null;
}

function isExpired(isoText, ttlMs, now = Date.now()) {
  if (!isoText) {
    return true;
  }
  const ts = new Date(isoText).getTime();
  if (Number.isNaN(ts)) {
    return true;
  }
  return now - ts >= ttlMs;
}

export function deriveStockSnapshot(stock, quotes, histories) {
  // 规则引擎只认统一快照结构，不直接依赖原始 API 字段，方便未来换源。
  const symbol = buildFullSymbol(stock.code, stock.market);
  const quote = quotes[symbol] || null;
  const history = histories[symbol] || [];
  const latestCandle = history[history.length - 1] || null;
  const prevCandle = history[history.length - 2] || null;

  return {
    stock,
    symbol,
    quote,
    history,
    latestCandle,
    prevCandle,
    marketDate: quote?.date || latestCandle?.date || formatDate(),
    currentPrice: quote?.price || latestCandle?.close || 0,
    currentOpen: quote?.open || latestCandle?.open || 0,
    currentVolume: quote?.volume || latestCandle?.volume || 0,
    currentChangePct: quote?.changePct ?? latestCandle?.changePct ?? 0,
    ma5: latestCandle?.ma5 ?? null,
    bbi: latestCandle?.bbi ?? null,
    macdDif: latestCandle?.macdDif ?? null,
    macdDea: latestCandle?.macdDea ?? null,
    prevMacdDif: prevCandle?.macdDif ?? null,
    prevMacdDea: prevCandle?.macdDea ?? null,
    kdjK: latestCandle?.kdjK ?? null,
    kdjD: latestCandle?.kdjD ?? null,
    kdjJ: latestCandle?.kdjJ ?? null,
    prevKdjK: prevCandle?.kdjK ?? null,
    prevKdjD: prevCandle?.kdjD ?? null,
    prevVolume: prevCandle?.volume || 0
  };
}

export async function searchEastMoneyStocks(keyword) {
  if (!keyword || keyword.trim().length < 1) {
    return [];
  }
  const encoded = encodeURIComponent(keyword.trim());
  const url = `https://searchapi.eastmoney.com/api/sse/get/jsonp?cb=&keyword=${encoded}&type=&token=894051a01f8dad965a53955f76d19783&count=10`;
  try {
    const response = await fetch(url);
    const text = await response.text();
    const jsonStr = text.replace(/^[^(]+\(/, "").replace(/\);?$/, "");
    const data = JSON.parse(jsonStr);
    const items = data?.data?.sse?.qtc?.zs || [];
    return items.slice(0, 10).map((item) => ({
      code: item.qtmc || item.zscode || "",
      name: item.qtnmc || item.zsname || "",
      market: inferMarket(item.qtmc || item.zscode || ""),
      changePct: item.qtf03 || 0,
      price: item.qtqp || 0
    })).filter((item) => item.code && item.name);
  } catch (err) {
    console.error("Stock search failed:", err);
    return [];
  }
}
