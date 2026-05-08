// 行情接口层统一封装免费数据源：
// - 东方财富个股接口负责最新报价
// - 东方财富 K 线接口负责历史日线
// 这样 A 股和港股都能走同一条更新链路
import { CACHE_POLICY } from "./defaults.js";
import { attachIndicators } from "./indicators.js";
import {
  buildEastMoneySecid,
  buildFullSymbol,
  formatDate,
  inferMarket,
  round,
  toNumber
} from "./utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchEastMoneyQuotes(watchlist) {
  // 改用 push2his K 线接口取最新日报价。
  // push2 stock/get 在 Chrome 扩展 Service Worker 中频繁 Failed to fetch，
  // push2his 域名不同，连接池独立，可靠性更高。
  if (!watchlist.length) {
    return {};
  }

  const result = {};

  for (const item of watchlist) {
    const market = item.market || inferMarket(item.code);
    const symbol = buildFullSymbol(item.code, market);

    try {
      const klineData = await fetchEastMoneyHistory(item.code, market, 1);
      const latest = klineData && klineData.length > 0
        ? klineData[klineData.length - 1]
        : null;

      if (latest && latest.close > 0) {
        const price = latest.close;
        const prevClose = round(price - (latest.change || 0), 2);
        result[symbol] = {
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
          change: latest.change || 0,
          changePct: latest.changePct || 0,
          date: formatDate(),
          time: new Date().toTimeString().slice(0, 8),
          fetchedAt: new Date().toISOString()
        };
      } else {
        console.warn(`[quote] no kline data for ${symbol}`);
      }
    } catch (error) {
      console.error(`[quote] kline failed for ${symbol}`, error);
    }

    await sleep(300);
  }

  console.log(`[quote] done, ${Object.keys(result).length}/${watchlist.length} ok`);
  return result;
}

export async function fetchStockUniverse() {
  // 拉取 A股 + 港股 基础列表，用于本地搜索补全，避免每次输入都打搜索接口。
  const fields = "f12,f13,f14";
  const aShareFs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
  const hkFs = "m:116+t:3";
  const bseFs = "m:0+t:81";

  const [aShareList, hkList, bseList] = await Promise.all([
    fetchClistPage(aShareFs, fields, 1, 6000),
    fetchClistPage(hkFs, fields, 1, 4000),
    fetchClistPage(bseFs, fields, 1, 8000)
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

  const url = `https://suggest3.sinajs.cn/suggest/key=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    headers: {
      Referer: "https://finance.sina.com.cn/"
    }
  });
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
    `&lmt=${safeLimit}&end=20500101`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`EastMoney kline HTTP ${response.status} for ${secid}`);
  }
  const payload = await response.json();
  const klines = payload?.data?.klines || [];

  const candles = klines.map((row) => {
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

  return attachIndicators(candles);
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

  const parsed = trends.map((row) => {
    const [time, price, avgPrice, volume, amount] = row.split(",");
    return {
      time,
      price: toNumber(price),
      avgPrice: toNumber(avgPrice),
      volume: toNumber(amount),  // 使用 amount（成交额）作为 volume，单位：万元
      amount: toNumber(amount)
    };
  });

  // volume 是累计值，转成每分钟增量
  return parsed.map((item, index) => ({
    ...item,
    volume: index === 0 ? 0 : Math.max(item.volume - parsed[index - 1].volume, 0)
  }));
}

export async function fetchMarketBundle(watchlist, historyDays = 120) {
  // 后台轮询时统一组装 quotes + histories，前台页面直接消费缓存即可。
  const quotes = await fetchEastMoneyQuotes(watchlist);
  const histories = {};

  for (const item of watchlist) {
    const market = item.market || inferMarket(item.code);
    const symbol = buildFullSymbol(item.code, market);
    histories[symbol] = await fetchEastMoneyHistory(item.code, market, historyDays);
  }

  return {
    quotes,
    histories,
    quoteUpdatedAtBySymbol: Object.fromEntries(Object.keys(quotes).map((symbol) => [symbol, new Date().toISOString()])),
    historyUpdatedAtBySymbol: Object.fromEntries(Object.keys(histories).map((symbol) => [symbol, new Date().toISOString()])),
    lastUpdatedAt: new Date().toISOString()
  };
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

  // 缓存 key 迁移：当 watchlist 的 market 修正后（如 sz→bj），将旧 key 数据移到新 key
  const ALL_MARKETS = ["sh", "sz", "hk", "bj"];
  for (const item of watchlist) {
    const correctSymbol = buildFullSymbol(item.code, item.market);
    for (const oldMarket of ALL_MARKETS) {
      if (oldMarket === item.market) continue;
      const oldSymbol = `${oldMarket}${item.code}`;
      if (quotes[oldSymbol] && !quotes[correctSymbol]) {
        quotes[correctSymbol] = { ...quotes[oldSymbol], symbol: correctSymbol, market: item.market };
        delete quotes[oldSymbol];
        if (quoteUpdatedAtBySymbol[oldSymbol]) {
          quoteUpdatedAtBySymbol[correctSymbol] = quoteUpdatedAtBySymbol[oldSymbol];
          delete quoteUpdatedAtBySymbol[oldSymbol];
        }
      }
      if (histories[oldSymbol] && !histories[correctSymbol]) {
        histories[correctSymbol] = histories[oldSymbol];
        delete histories[oldSymbol];
        if (historyUpdatedAtBySymbol[oldSymbol]) {
          historyUpdatedAtBySymbol[correctSymbol] = historyUpdatedAtBySymbol[oldSymbol];
          delete historyUpdatedAtBySymbol[oldSymbol];
        }
      }
    }
  }

  const symbols = watchlist.map((item) => buildFullSymbol(item.code, item.market));
  const now = Date.now();

  // 缓存 key 迁移：当 watchlist 的 market 修正后（如 sz→bj），将旧 key 数据移到新 key
  // （已在上面的循环中完成）

  // 先拉 history，然后从 history 缓存末尾提取 quote，
  // 避免 fetchEastMoneyQuotes 和 fetchEastMoneyHistory 对同一只股票发两次 kline 请求。
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
          if (!histories[symbol]?.length) {
            throw error;
          }
          console.warn(`History refresh failed for ${symbol}, fallback to cached history`, error);
        }
      })
    );
    if (batchStart + BATCH_SIZE < staleHistoryItems.length) {
      await sleep(CACHE_POLICY.requestGapMs * BATCH_SIZE);
    }
  }

  // 从 history 缓存中提取最新日报价
  const staleQuoteSymbols = watchlist
    .map((item) => buildFullSymbol(item.code, item.market))
    .filter((symbol) => forceQuotes || isExpired(quoteUpdatedAtBySymbol[symbol], quoteTtlMs, now));

  for (const symbol of staleQuoteSymbols) {
    const klineData = histories[symbol];
    const latest = klineData && klineData.length > 0
      ? klineData[klineData.length - 1]
      : null;

    if (latest && latest.close > 0) {
      const item = watchlist.find((w) => buildFullSymbol(w.code, w.market) === symbol);
      const market = item?.market || "sz";
      const price = latest.close;
      const prevClose = price - (latest.change || 0);
      quotes[symbol] = {
        symbol,
        code: market === "hk"
          ? String(item.code).padStart(5, "0")
          : String(item.code).padStart(6, "0"),
        market,
        name: item?.name || item?.code || "",
        open: latest.open || 0,
        prevClose,
        price,
        high: latest.high || 0,
        low: latest.low || 0,
        volume: latest.volume || 0,
        turnover: 0,
        change: latest.change || 0,
        changePct: latest.changePct || 0,
        date: formatDate(),
        time: new Date().toTimeString().slice(0, 8),
        fetchedAt: new Date().toISOString()
      };
      quoteUpdatedAtBySymbol[symbol] = new Date().toISOString();
    }
  }

  // 如果还有 symbol 没有 quote（history 缓存仍为空），单独拉 1 条 kline 作兜底
  // 直接调 fetchEastMoneyHistory 而非 fetchEastMoneyQuotes，避免对同一只股票发两次请求
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
            const price = latest.close;
            const prevClose = price - (latest.change || 0);
            quotes[symbol] = {
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
              change: latest.change || 0,
              changePct: latest.changePct || 0,
              date: formatDate(),
              time: new Date().toTimeString().slice(0, 8),
              fetchedAt: new Date().toISOString()
            };
            quoteUpdatedAtBySymbol[symbol] = new Date().toISOString();
          }
        } catch (error) {
          console.warn(`Fallback quote fetch failed for ${symbol}`, error);
        }
      })
    );
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
  return now - new Date(isoText).getTime() >= ttlMs;
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
      market: item.qtmtp === "2" ? "hk" : item.zsmarket === "hgt" ? "hk" : "sh",
      changePct: item.qtf03 || 0,
      price: item.qtqp || 0
    })).filter((item) => item.code && item.name);
  } catch (err) {
    console.error("Stock search failed:", err);
    return [];
  }
}
