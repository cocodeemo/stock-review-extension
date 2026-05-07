// 技术指标集中放在这个文件，后续新增 RSI/KDJ/布林带时也建议继续在这里扩展。
import { round, toNumber } from "./utils.js";

export function calcMA(candles, period) {
  // 简单移动平均线。
  return candles.map((_, index) => {
    if (index + 1 < period) {
      return null;
    }
    const window = candles.slice(index - period + 1, index + 1);
    const sum = window.reduce((total, candle) => total + toNumber(candle.close), 0);
    return round(sum / period, 3);
  });
}

export function calcBBI(candles) {
  // BBI = (MA3 + MA6 + MA12 + MA24) / 4
  const ma3 = calcMA(candles, 3);
  const ma6 = calcMA(candles, 6);
  const ma12 = calcMA(candles, 12);
  const ma24 = calcMA(candles, 24);

  return candles.map((_, index) => {
    const values = [ma3[index], ma6[index], ma12[index], ma24[index]].filter((value) => value !== null);
    if (values.length < 4) {
      return null;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return round(total / values.length, 3);
  });
}

export function calcEMA(values, period) {
  // MACD 依赖 EMA，因此单独抽出来复用。
  // 用前 period 个点的 SMA 作初始值，与同花顺/东方财富标准对齐。
  const multiplier = 2 / (period + 1);
  const result = [];
  values.forEach((value, index) => {
    const numeric = toNumber(value);
    if (index < period - 1) {
      result.push(null);
      return;
    }
    if (index === period - 1) {
      const sma = values.slice(0, period).reduce((sum, v) => sum + toNumber(v), 0) / period;
      result.push(round(sma, 4));
      return;
    }
    const previous = result[index - 1];
    result.push(round((numeric - previous) * multiplier + previous, 4));
  });
  return result;
}

export function calcMACD(candles, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
  // 标准 MACD：DIF = EMA12 - EMA26，DEA 为 DIF 的 EMA9，柱状图 = (DIF - DEA) * 2
  // EMA 初始阶段返回 null，DIF/DEA/histogram 同样传递 null 直到数据足够。
  const closes = candles.map((candle) => toNumber(candle.close));
  const emaShort = calcEMA(closes, shortPeriod);
  const emaLong = calcEMA(closes, longPeriod);
  const dif = closes.map((_, index) => {
    if (emaShort[index] === null || emaLong[index] === null) return null;
    return round(emaShort[index] - emaLong[index], 4);
  });
  const dea = calcEMA(dif.map((v) => v ?? 0), signalPeriod);
  const histogram = dif.map((value, index) => {
    if (value === null || dea[index] === null) return null;
    return round((value - dea[index]) * 2, 4);
  });

  const warmupLength = longPeriod - 1 + signalPeriod - 1;
  return candles.map((_, index) => ({
    dif: index < warmupLength ? null : dif[index],
    dea: index < warmupLength ? null : dea[index],
    histogram: index < warmupLength ? null : histogram[index]
  }));
}

export function calcKDJ(candles, period = 9) {
  const result = [];
  let previousK = 50;
  let previousD = 50;

  candles.forEach((candle, index) => {
    const window = candles.slice(Math.max(0, index - period + 1), index + 1);
    const lowestLow = Math.min(...window.map((item) => toNumber(item.low)));
    const highestHigh = Math.max(...window.map((item) => toNumber(item.high)));
    const close = toNumber(candle.close);
    const rsvBase = highestHigh - lowestLow;
    const rsv = rsvBase === 0 ? 50 : ((close - lowestLow) / rsvBase) * 100;
    const k = round((2 / 3) * previousK + (1 / 3) * rsv, 3);
    const d = round((2 / 3) * previousD + (1 / 3) * k, 3);
    const j = round(3 * k - 2 * d, 3);

    result.push({ k, d, j });
    previousK = k;
    previousD = d;
  });

  return result;
}

export function attachIndicators(candles) {
  // 拉取完原始日线后，一次性把常用指标挂到每根 K 线上，方便图表和规则直接读取。
  const ma5 = calcMA(candles, 5);
  const ma10 = calcMA(candles, 10);
  const ma20 = calcMA(candles, 20);
  const ma60 = calcMA(candles, 60);
  const bbi = calcBBI(candles);
  const macd = calcMACD(candles);
  const kdj = calcKDJ(candles);

  return candles.map((candle, index) => ({
    ...candle,
    ma5: ma5[index],
    ma10: ma10[index],
    ma20: ma20[index],
    ma60: ma60[index],
    bbi: bbi[index],
    macdDif: macd[index].dif,
    macdDea: macd[index].dea,
    macdHistogram: macd[index].histogram,
    kdjK: kdj[index].k,
    kdjD: kdj[index].d,
    kdjJ: kdj[index].j
  }));
}
