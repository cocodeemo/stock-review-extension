import { percent, round, toNumber } from "./utils.js";

function compareMACDCross(snapshot, direction) {
  const prevDif = snapshot.prevMacdDif;
  const prevDea = snapshot.prevMacdDea;
  const currentDif = snapshot.macdDif;
  const currentDea = snapshot.macdDea;

  if ([prevDif, prevDea, currentDif, currentDea].some((value) => value === null || value === undefined)) {
    return false;
  }

  if (direction === "golden") {
    return prevDif <= prevDea && currentDif > currentDea;
  }
  return prevDif >= prevDea && currentDif < currentDea;
}

function hasRecentMacdGolden(snapshot, lookback = 12) {
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  if (history.length < 2) {
    return false;
  }

  const recent = history.slice(-Math.max(lookback, 2));
  let latestCross = null;

  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1];
    const current = recent[index];
    const prevDif = previous.macdDif;
    const prevDea = previous.macdDea;
    const currentDif = current.macdDif;
    const currentDea = current.macdDea;

    if ([prevDif, prevDea, currentDif, currentDea].some((value) => value === null || value === undefined)) {
      continue;
    }

    if (prevDif <= prevDea && currentDif > currentDea) {
      latestCross = "golden";
    } else if (prevDif >= prevDea && currentDif < currentDea) {
      latestCross = "death";
    }
  }

  return latestCross === "golden";
}

function hasRecentGiantBearish(snapshot, lookback = 5, dropThreshold = 3, volumeRatioThreshold = 1.5) {
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  if (history.length < 2) {
    return false;
  }

  const recent = history.slice(-Math.max(lookback, 2));
  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1];
    const current = recent[index];
    const volumeRatio = previous.volume ? current.volume / previous.volume : 0;
    const isBearish = Number(current.close) < Number(current.open);
    const largeDrop = Number(current.changePct || 0) <= -Math.abs(dropThreshold);
    const hugeVolume = volumeRatio >= Number(volumeRatioThreshold || 1.5);
    if (isBearish && largeDrop && hugeVolume) {
      return true;
    }
  }

  return false;
}

function linearRegression(closes) {
  const n = closes.length;
  if (n < 5) return { slopePct: 0, r2: 0 };

  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (closes[i] - meanY);
    den += (i - meanX) ** 2;
    ssTot += (closes[i] - meanY) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const slopePct = meanY === 0 ? 0 : (slope / meanY) * 100;

  // R²：趋势的线性拟合优度，0~1，越高说明走势越线性
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = meanY + slope * (i - meanX);
    ssRes += (closes[i] - predicted) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slopePct, r2 };
}

function isKdjNotDead(snapshot) {
  const k = snapshot.kdjK;
  const d = snapshot.kdjD;
  if (k === null || k === undefined || d === null || d === undefined) {
    return false;
  }
  return Number(k) >= Number(d);
}

export function evaluateRule(rule, snapshot) {
  const currentPrice = snapshot.currentPrice;
  const currentOpen = snapshot.currentOpen;
  const currentChangePct = snapshot.currentChangePct;
  const volumeRatio = snapshot.prevVolume ? snapshot.currentVolume / snapshot.prevVolume : 0;
  const takeProfit = snapshot.stock.takeProfitPrice || 0;
  const stopLoss = snapshot.stock.stopLossPrice || 0;
  const threshold = toNumber(rule.params?.threshold);
  const period = toNumber(rule.params?.period) || 5;
  const lookback = toNumber(rule.params?.lookback) || 12;
  const dropThreshold = toNumber(rule.params?.dropThreshold) || 3;
  const volumeRatioThreshold = toNumber(rule.params?.volumeRatioThreshold) || 1.5;

  switch (rule.type) {
    case "price_above_ma":
      return {
        matched: snapshot.latestCandle?.[`ma${period}`] != null && currentPrice > snapshot.latestCandle[`ma${period}`],
        detail: `现价 ${currentPrice} / MA${period} ${snapshot.latestCandle?.[`ma${period}`] ?? "--"}`
      };
    case "price_below_ma":
      return {
        matched: snapshot.latestCandle?.[`ma${period}`] != null && currentPrice < snapshot.latestCandle[`ma${period}`],
        detail: `现价 ${currentPrice} / MA${period} ${snapshot.latestCandle?.[`ma${period}`] ?? "--"}`
      };
    case "price_above_bbi":
      return {
        matched: snapshot.bbi !== null && currentPrice > snapshot.bbi,
        detail: `现价 ${currentPrice} / BBI ${snapshot.bbi ?? "--"}`
      };
    case "price_not_below_bbi":
      return {
        matched: snapshot.bbi !== null && currentPrice >= snapshot.bbi,
        detail: `现价 ${currentPrice} / BBI ${snapshot.bbi ?? "--"}`
      };
    case "price_below_bbi":
      return {
        matched: snapshot.bbi !== null && currentPrice < snapshot.bbi,
        detail: `现价 ${currentPrice} / BBI ${snapshot.bbi ?? "--"}`
      };
    case "daily_change_pct_gte":
      return {
        matched: currentChangePct >= threshold,
        detail: `当日涨幅 ${percent(currentChangePct)}`
      };
    case "daily_change_pct_lte":
      return {
        matched: currentChangePct <= -Math.abs(threshold),
        detail: `当日跌幅 ${percent(currentChangePct)}`
      };
    case "daily_abs_change_pct_gte":
      return {
        matched: Math.abs(currentChangePct) >= threshold,
        detail: `当日涨跌幅 ${percent(currentChangePct)}`
      };
    case "volume_ratio_gte":
      return {
        matched: volumeRatio >= threshold,
        detail: `量比 ${round(volumeRatio, 2)}`
      };
    case "volume_ratio_lte":
      return {
        matched: volumeRatio > 0 && volumeRatio <= threshold,
        detail: `量比 ${round(volumeRatio, 2)}`
      };
    case "take_profit_hit":
      return {
        matched: takeProfit > 0 && currentPrice >= takeProfit,
        detail: `现价 ${currentPrice} / 止盈 ${takeProfit || "--"}`
      };
    case "stop_loss_hit":
      return {
        matched: stopLoss > 0 && currentPrice <= stopLoss,
        detail: `现价 ${currentPrice} / 止损 ${stopLoss || "--"}`
      };
    case "position_take_profit_or_stop_loss":
      return {
        matched: (takeProfit > 0 && currentPrice >= takeProfit) || (stopLoss > 0 && currentPrice <= stopLoss),
        detail: `现价 ${currentPrice} / 止盈 ${takeProfit || "--"} / 止损 ${stopLoss || "--"}`
      };
    case "close_above_open": {
      const prevClose = snapshot.quote?.prevClose || snapshot.prevCandle?.close || 0;
      return {
        matched: prevClose > 0 && snapshot.currentPrice > prevClose,
        detail: `今收 ${snapshot.currentPrice} > 昨收 ${prevClose}`
      };
    }
    case "volume_up_vs_prev":
      return {
        matched: snapshot.currentVolume > snapshot.prevVolume,
        detail: `今量 ${round(snapshot.currentVolume, 0)} / 昨量 ${round(snapshot.prevVolume, 0)}`
      };
    case "macd_golden_cross":
      return {
        matched: hasRecentMacdGolden(snapshot, lookback),
        detail: `最近${lookback}日内有过金叉，且当前未被死叉破坏 | DIF ${snapshot.macdDif ?? "--"} / DEA ${snapshot.macdDea ?? "--"}`
      };
    case "macd_death_cross":
      return {
        matched: compareMACDCross(snapshot, "death"),
        detail: `DIF ${snapshot.macdDif ?? "--"} / DEA ${snapshot.macdDea ?? "--"}`
      };
    case "no_giant_bearish_candle":
      return {
        matched: !hasRecentGiantBearish(snapshot, lookback, dropThreshold, volumeRatioThreshold),
        detail: `最近${lookback}日无巨量阴线 | 跌幅阈值 ${dropThreshold}% / 放量阈值 ${volumeRatioThreshold}倍`
      };
    case "trend_up": {
      const minSlopePct = Number(rule.params?.minSlopePct ?? 0.05);
      const minR2 = Number(rule.params?.minR2 ?? 0.3);
      const n = Math.min(lookback, snapshot.history?.length ?? 0);
      const closes = (snapshot.history ?? []).slice(-n).map((c) => Number(c.close));
      const { slopePct, r2 } = linearRegression(closes);
      const matched = slopePct >= minSlopePct && r2 >= minR2;
      return {
        matched,
        detail: `近${n}日斜率 ${slopePct >= 0 ? "+" : ""}${slopePct.toFixed(3)}%/日 · R² ${r2.toFixed(2)}`
      };
    }
    case "kdj_not_dead_cross":
      return {
        matched: isKdjNotDead(snapshot),
        detail: `K ${snapshot.kdjK ?? "--"} / D ${snapshot.kdjD ?? "--"} / J ${snapshot.kdjJ ?? "--"}`
      };
    default:
      return {
        matched: false,
        detail: "未识别规则"
      };
  }
}

export function evaluateAlerts(alertRules, snapshots) {
  const hits = [];
  const enabledRules = alertRules.filter((item) => item.enabled);

  for (const snapshot of snapshots) {
    for (const rule of enabledRules) {
      const result = evaluateRule(rule, snapshot);
      if (result.matched) {
        hits.push({
          stockCode: snapshot.stock.code,
          stockName: snapshot.stock.name,
          symbol: snapshot.symbol,
          ruleId: rule.id,
          ruleName: rule.name,
          currentPrice: snapshot.currentPrice,
          currentChangePct: snapshot.currentChangePct,
          detail: result.detail,
          triggeredAt: new Date().toISOString()
        });
      }
    }
  }

  return hits;
}

export function evaluateScores(scoreRules, snapshots) {
  const enabledRules = scoreRules.filter((rule) => rule.enabled);
  return snapshots.map((snapshot) => {
    const matched = [];
    const missed = [];
    let totalScore = 0;

    enabledRules.forEach((rule) => {
      const result = evaluateRule(rule, snapshot);
      const item = {
        ruleId: rule.id,
        ruleName: rule.name,
        points: Number(rule.points || 0),
        detail: result.detail
      };
      if (result.matched) {
        totalScore += item.points;
        matched.push(item);
      } else {
        missed.push(item);
      }
    });

    return {
      code: snapshot.stock.code,
      market: snapshot.stock.market,
      name: snapshot.stock.name,
      totalScore,
      currentPrice: snapshot.currentPrice,
      currentChangePct: snapshot.currentChangePct,
      ma5: snapshot.ma5,
      bbi: snapshot.bbi,
      matched,
      missed,
      quoteDate: snapshot.marketDate
    };
  });
}
