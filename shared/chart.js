import { round } from "./utils.js";

export function drawCandles(canvas, candles = [], crosshairIndex = -1) {
  if (!canvas) return;
  if (!candles.length) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth > 0 ? canvas.clientWidth : Math.round(canvas.width / dpr);
  const cssHeight = canvas.clientHeight > 0 ? canvas.clientHeight : Math.round(canvas.height / dpr);
  const targetW = Math.round(cssWidth * dpr);
  const targetH = Math.round(cssHeight * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = cssWidth;
  const height = cssHeight;

  // Layout: leave right margin for price axis, bottom margin for date axis
  const marginRight = 58;
  const marginBottom = 22;
  const marginLeft = 6;
  const marginTop = 8;

  const chartW = width - marginLeft - marginRight;
  const totalChartH = height - marginTop - marginBottom;
  const priceH = Math.floor(totalChartH * 0.72);
  const volH = totalChartH - priceH;

  const visible = candles.slice(-45);

  // Colors: match dashboard theme (red up, green down)
  const COLOR_UP = "#c9302c";
  const COLOR_DOWN = "#1f8b4c";
  const BG = "#fdfbfa";
  const GRID = "rgba(201,48,44,0.08)";
  const AXIS_LABEL = "rgba(103,112,125,0.75)";

  // Background
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  // Subtle inner glow on chart area edges
  const grd = ctx.createLinearGradient(marginLeft, marginTop, marginLeft, marginTop + priceH);
  grd.addColorStop(0, "rgba(201,48,44,0.02)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(marginLeft, marginTop, chartW, priceH);

  const highs = visible.map((c) => c.high);
  const lows = visible.map((c) => c.low);
  const volumes = visible.map((c) => c.volume);
  let maxPrice = Math.max(...highs);
  let minPrice = Math.min(...lows);
  // Add 2% padding so candles don't touch edges
  const spread = Math.max(maxPrice - minPrice, 0.01);
  maxPrice += spread * 0.04;
  minPrice -= spread * 0.04;
  const maxVolume = Math.max(...volumes, 1);
  const barWidth = chartW / visible.length;

  const pY = (price) => {
    const s = Math.max(maxPrice - minPrice, 0.01);
    return marginTop + ((maxPrice - price) / s) * (priceH - 2) + 1;
  };

  // Grid lines + price axis labels (5 levels)
  ctx.font = `10px "Segoe UI", "PingFang SC", monospace`;
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y = marginTop + frac * priceH;
    const priceVal = maxPrice - frac * (maxPrice - minPrice);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + chartW, y);
    ctx.stroke();

    ctx.fillStyle = AXIS_LABEL;
    ctx.textAlign = "left";
    ctx.fillText(round(priceVal, 2), marginLeft + chartW + 4, y);
  }

  // Volume area separator line
  ctx.strokeStyle = "rgba(201,48,44,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop + priceH);
  ctx.lineTo(marginLeft + chartW, marginTop + priceH);
  ctx.stroke();

  // Candles
  visible.forEach((item, index) => {
    const cx = marginLeft + index * barWidth + barWidth / 2;
    const isUp = item.close >= item.open;
    const color = isUp ? COLOR_UP : COLOR_DOWN;

    const highY = pY(item.high);
    const lowY = pY(item.low);
    const openY = pY(item.open);
    const closeY = pY(item.close);

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, highY);
    ctx.lineTo(cx, lowY);
    ctx.stroke();

    // Body
    const bodyTop = Math.min(openY, closeY);
    const bodyBot = Math.max(openY, closeY);
    const bodyH = Math.max(bodyBot - bodyTop, 1.5);
    const halfBody = barWidth * 0.38;

    if (isUp) {
      // Hollow white body (up candle)
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.rect(cx - halfBody, bodyTop, halfBody * 2, bodyH);
      ctx.fill();
      ctx.stroke();
    } else {
      // Filled body (down candle)
      ctx.fillStyle = color;
      ctx.fillRect(cx - halfBody, bodyTop, halfBody * 2, bodyH);
    }

    // Volume bar
    const volBarH = Math.max((item.volume / maxVolume) * (volH - 6), 1);
    const volY = marginTop + priceH + volH - volBarH;
    ctx.fillStyle = isUp
      ? "rgba(201,48,44,0.6)"
      : "rgba(31,139,76,0.6)";
    ctx.fillRect(cx - halfBody, volY, halfBody * 2, volBarH);
  });

  // MA lines
  drawLine(ctx, visible, "ma5", "#e67e22", maxPrice, minPrice, priceH, barWidth, marginLeft, marginTop);
  drawLine(ctx, visible, "bbi", "#2f6fed", maxPrice, minPrice, priceH, barWidth, marginLeft, marginTop);

  // MA legend top-left
  ctx.font = `10px "Segoe UI", "PingFang SC", sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const lastVisible = visible[visible.length - 1];
  if (lastVisible) {
    let lx = marginLeft + 4;
    if (lastVisible.ma5 != null) {
      ctx.fillStyle = "#e67e22";
      ctx.fillText(`MA5 ${round(lastVisible.ma5, 2)}`, lx, marginTop + 14);
      lx += ctx.measureText(`MA5 ${round(lastVisible.ma5, 2)}`).width + 10;
    }
    if (lastVisible.bbi != null) {
      ctx.fillStyle = "#2f6fed";
      ctx.fillText(`BBI ${round(lastVisible.bbi, 2)}`, lx, marginTop + 14);
    }
  }

  // Date axis labels on bottom (~5 evenly spaced)
  ctx.fillStyle = AXIS_LABEL;
  ctx.font = `10px "Segoe UI", "PingFang SC", monospace`;
  ctx.textBaseline = "alphabetic";
  const dateCount = 5;
  for (let i = 0; i < dateCount; i++) {
    const idx = Math.round((i / (dateCount - 1)) * (visible.length - 1));
    const item = visible[idx];
    if (!item || !item.date) continue;
    const dateStr = String(item.date).slice(5, 10);
    const dx = marginLeft + idx * barWidth + barWidth / 2;
    ctx.textAlign = i === 0 ? "left" : i === dateCount - 1 ? "right" : "center";
    ctx.fillText(dateStr, dx, height - 4);
  }

  // Crosshair
  if (crosshairIndex >= 0 && crosshairIndex < visible.length) {
    const item = visible[crosshairIndex];
    const cx = marginLeft + crosshairIndex * barWidth + barWidth / 2;
    const closeY = pY(item.close);
    const isUp = item.close >= item.open;

    ctx.save();
    ctx.strokeStyle = "rgba(103,112,125,0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(cx, marginTop); ctx.lineTo(cx, marginTop + priceH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(marginLeft, closeY); ctx.lineTo(marginLeft + chartW, closeY); ctx.stroke();
    ctx.setLineDash([]);

    // Price label on right axis
    ctx.fillStyle = isUp ? "rgba(201,48,44,0.9)" : "rgba(31,139,76,0.9)";
    ctx.beginPath();
    ctx.roundRect(marginLeft + chartW + 1, closeY - 9, marginRight - 2, 18, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 10px "Segoe UI", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(round(item.close, 2), marginLeft + chartW + marginRight / 2, closeY);
    ctx.restore();

    // OHLC tooltip
    const prevClose = crosshairIndex > 0 ? visible[crosshairIndex - 1].close : (visible[0]?.open ?? item.open);
    const changePct = prevClose > 0 ? ((item.close - prevClose) / prevClose * 100) : 0;
    const sign = changePct >= 0 ? "+" : "";
    const volStr = item.turnover >= 1e8
      ? `${round(item.turnover / 1e8, 2)}亿`
      : item.turnover >= 1e4
        ? `${round(item.turnover / 1e4, 0)}万`
        : `${round(item.turnover, 0)}`;
    const dateStr = item.date ? String(item.date).slice(0, 10) : "";

    const lines = [
      { label: dateStr, value: "", accent: false },
      { label: "开", value: round(item.open, 2), accent: false },
      { label: "高", value: round(item.high, 2), accent: false },
      { label: "低", value: round(item.low, 2), accent: false },
      { label: "收", value: `${round(item.close, 2)}  ${sign}${round(changePct, 2)}%`, accent: true, up: isUp },
      { label: "额", value: volStr, accent: false },
    ];

    ctx.font = `11px "Segoe UI", "PingFang SC", sans-serif`;
    const lineH = 16;
    const boxPadX = 10;
    const boxPadY = 8;
    const maxLabelW = Math.max(...lines.map(l => ctx.measureText(`${l.label}  ${l.value}`).width));
    const boxW = maxLabelW + boxPadX * 2;
    const boxH = lines.length * lineH + boxPadY * 2;

    let bx = cx + 12;
    if (bx + boxW > marginLeft + chartW) bx = cx - boxW - 12;
    bx = Math.max(marginLeft, Math.min(bx, marginLeft + chartW - boxW));
    const by = Math.max(marginTop, Math.min(closeY - boxH / 2, marginTop + priceH - boxH));

    // Box background with subtle border
    ctx.save();
    ctx.fillStyle = "rgba(255,248,246,0.96)";
    ctx.strokeStyle = isUp ? "rgba(201,48,44,0.25)" : "rgba(31,139,76,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();

    lines.forEach((line, i) => {
      const ly = by + boxPadY + i * lineH + lineH * 0.75;
      if (i === 0) {
        ctx.fillStyle = "rgba(103,112,125,0.6)";
        ctx.font = `10px "Segoe UI", monospace`;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(line.label, bx + boxPadX, ly);
        return;
      }
      ctx.font = `11px "Segoe UI", "PingFang SC", sans-serif`;
      ctx.fillStyle = "rgba(103,112,125,0.7)";
      ctx.textAlign = "left";
      ctx.fillText(line.label, bx + boxPadX, ly);
      if (line.accent) {
        ctx.fillStyle = line.up ? COLOR_UP : COLOR_DOWN;
      } else {
        ctx.fillStyle = "rgba(22,24,29,0.9)";
      }
      ctx.textAlign = "right";
      ctx.fillText(line.value, bx + boxW - boxPadX, ly);
    });
    ctx.restore();
  }
}

export function drawIntradayLine(canvas, points = [], prevClose = 0, crosshairIndex = -1) {
  if (!canvas) return;
  if (!points.length) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth > 0 ? canvas.clientWidth : Math.round(canvas.width / dpr);
  const cssHeight = canvas.clientHeight > 0 ? canvas.clientHeight : Math.round(canvas.height / dpr);
  const targetW = Math.round(cssWidth * dpr);
  const targetH = Math.round(cssHeight * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = cssWidth;
  const height = cssHeight;
  // Left axis for price, right axis for pct change
  const marginLeft = 54;
  const marginRight = 52;
  const marginTop = 20;
  const marginBottom = 28;
  const chartW = width - marginLeft - marginRight;
  const chartH = height - marginTop - marginBottom;
  const priceH = Math.floor(chartH * 0.75);
  const volumeH = chartH - priceH - 8;

  const prices = points.map((p) => p.price);
  const avgPrices = points.map((p) => p.avgPrice).filter(Boolean);
  const volumes = points.map((p) => p.volume);

  const centerPrice = prevClose > 0 ? prevClose : (Math.max(...prices) + Math.min(...prices)) / 2;
  const maxDiff = Math.max(
    Math.abs(Math.max(...prices, ...(avgPrices.length ? avgPrices : prices)) - centerPrice),
    Math.abs(Math.min(...prices, ...(avgPrices.length ? avgPrices : prices)) - centerPrice),
    0.01
  );
  const maxPrice = centerPrice + maxDiff;
  const minPrice = centerPrice - maxDiff;
  const maxVolume = Math.max(...volumes, 1);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const priceY = (price) => marginTop + ((maxPrice - price) / (maxPrice - minPrice)) * priceH;

  // Horizontal grid lines (5 levels)
  ctx.strokeStyle = "rgba(103,112,125,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = marginTop + (priceH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + chartW, y);
    ctx.stroke();
  }

  // Vertical time grid lines + noon break line
  // Data: 09:30-11:30 (120 min) + 13:00-15:00 (120 min) = 240 points
  // Find the noon break index (first afternoon point)
  let noonIndex = -1;
  for (let i = 1; i < points.length; i++) {
    const prevHour = parseInt(points[i - 1].time.slice(11, 13), 10);
    const curHour = parseInt(points[i].time.slice(11, 13), 10);
    if (curHour >= 13 && prevHour <= 11) { noonIndex = i; break; }
  }

  const barWidth = chartW / Math.max(points.length - 1, 1);
  ctx.strokeStyle = "rgba(103,112,125,0.12)";
  ctx.lineWidth = 1;
  const timeSteps = 4;
  for (let i = 1; i < timeSteps; i++) {
    const x = marginLeft + (chartW / timeSteps) * i;
    ctx.beginPath();
    ctx.moveTo(x, marginTop);
    ctx.lineTo(x, marginTop + priceH);
    ctx.stroke();
  }

  // Noon break vertical dashed line
  if (noonIndex > 0) {
    const nx = marginLeft + noonIndex * barWidth;
    ctx.save();
    ctx.strokeStyle = "rgba(103,112,125,0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(nx, marginTop);
    ctx.lineTo(nx, marginTop + priceH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Previous close baseline (horizontal dashed)
  if (prevClose > 0) {
    const y = priceY(prevClose);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(103,112,125,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + chartW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Left axis: price labels
  ctx.font = "10px 'Segoe UI', 'PingFang SC', monospace";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const price = maxPrice - (maxPrice - minPrice) * (i / 4);
    const y = marginTop + (priceH / 4) * i;
    const pctChange = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;
    // Left: absolute price, colored by direction
    ctx.fillStyle = pctChange > 0 ? "rgba(201,48,44,0.85)" : pctChange < 0 ? "rgba(31,139,76,0.85)" : "rgba(103,112,125,0.7)";
    ctx.textAlign = "right";
    ctx.fillText(round(price, 2), marginLeft - 4, y);
    // Right: pct change
    const pctStr = pctChange >= 0 ? `+${pctChange.toFixed(2)}%` : `${pctChange.toFixed(2)}%`;
    ctx.fillStyle = pctChange > 0 ? "rgba(201,48,44,0.85)" : pctChange < 0 ? "rgba(31,139,76,0.85)" : "rgba(103,112,125,0.7)";
    ctx.textAlign = "left";
    ctx.fillText(pctStr, marginLeft + chartW + 4, y);
  }

  // Time axis labels (bottom)
  ctx.fillStyle = "rgba(103,112,125,0.65)";
  ctx.font = "10px 'Segoe UI', 'PingFang SC', monospace";
  ctx.textBaseline = "top";
  const timeLabels = ["09:30", "10:30", "11:30/13:00", "14:00", "15:00"];
  timeLabels.forEach((label, i) => {
    const x = marginLeft + (chartW / (timeLabels.length - 1)) * i;
    ctx.textAlign = i === 0 ? "left" : i === timeLabels.length - 1 ? "right" : "center";
    ctx.fillText(label, x, marginTop + priceH + 5);
  });

  // Draw price line
  ctx.strokeStyle = "#2f6fed";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  points.forEach((item, index) => {
    if (item.price == null) return;
    const x = marginLeft + index * barWidth;
    const y = priceY(item.price);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, y); }
  });
  ctx.stroke();

  // Gradient fill under price line
  if (started) {
    const gradient = ctx.createLinearGradient(0, marginTop, 0, marginTop + priceH);
    gradient.addColorStop(0, "rgba(47,111,237,0.18)");
    gradient.addColorStop(0.6, "rgba(47,111,237,0.06)");
    gradient.addColorStop(1, "rgba(47,111,237,0.01)");
    ctx.fillStyle = gradient;
    ctx.lineTo(marginLeft + (points.length - 1) * barWidth, marginTop + priceH);
    ctx.lineTo(marginLeft, marginTop + priceH);
    ctx.closePath();
    ctx.fill();
  }

  // Average price line (yellow)
  if (avgPrices.length > 0) {
    ctx.strokeStyle = "rgba(230,126,34,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    started = false;
    points.forEach((item, index) => {
      if (item.avgPrice == null) return;
      const x = marginLeft + index * barWidth;
      const y = priceY(item.avgPrice);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
  }

  // Volume bars
  const volumeBarWidth = Math.max(chartW / points.length, 1);
  const volumeTop = marginTop + priceH + 8;
  points.forEach((item, index) => {
    const x = marginLeft + index * volumeBarWidth;
    const barH = Math.max((item.volume / maxVolume) * volumeH, 1);
    const isUp = item.price >= prevClose;
    ctx.fillStyle = isUp ? "rgba(201,48,44,0.85)" : "rgba(31,139,76,0.85)";
    ctx.fillRect(x, volumeTop + volumeH - barH, Math.max(volumeBarWidth - 0.3, 0.8), barH);
  });

  // Volume max label (maxVolume 单位：万元)
  ctx.fillStyle = "rgba(103,112,125,0.65)";
  ctx.font = "10px 'Segoe UI', 'PingFang SC', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const volStr = maxVolume >= 1e4 ? `VOL ${(maxVolume / 1e4).toFixed(1)}亿` : `VOL ${maxVolume.toFixed(1)}万`;
  ctx.fillText(volStr, marginLeft + 2, volumeTop + 2);

  // Crosshair
  if (crosshairIndex >= 0 && crosshairIndex < points.length) {
    const item = points[crosshairIndex];
    const cx = marginLeft + crosshairIndex * barWidth;
    const cy = priceY(item.price);

    ctx.save();
    ctx.strokeStyle = "rgba(103,112,125,0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, marginTop);
    ctx.lineTo(cx, marginTop + priceH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(marginLeft, cy);
    ctx.lineTo(marginLeft + chartW, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Price label on left axis
    const changePct = prevClose > 0 ? ((item.price - prevClose) / prevClose * 100) : 0;
    const isUp = changePct >= 0;
    ctx.save();
    ctx.fillStyle = isUp ? "rgba(201,48,44,0.9)" : "rgba(31,139,76,0.9)";
    ctx.beginPath();
    ctx.roundRect(0, cy - 9, marginLeft - 2, 18, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 10px 'Segoe UI', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(round(item.price, 2), (marginLeft - 2) / 2, cy);
    ctx.restore();

    // Pct label on right axis
    const sign = changePct >= 0 ? "+" : "";
    const pctStr = `${sign}${changePct.toFixed(2)}%`;
    ctx.save();
    ctx.fillStyle = isUp ? "rgba(201,48,44,0.9)" : "rgba(31,139,76,0.9)";
    ctx.beginPath();
    ctx.roundRect(marginLeft + chartW + 2, cy - 9, marginRight - 2, 18, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 10px 'Segoe UI', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(pctStr, marginLeft + chartW + 2 + (marginRight - 2) / 2, cy);
    ctx.restore();

    // Tooltip
    const lines = [
      { label: "时间", value: item.time.slice(11, 16) },
      { label: "价格", value: round(item.price, 2), accent: true },
      { label: "涨跌", value: `${sign}${changePct.toFixed(2)}%`, accent: true },
      { label: "均价", value: item.avgPrice ? round(item.avgPrice, 2) : "--" },
      { label: "成交量", value: item.volume >= 1e8 ? (item.volume / 1e8).toFixed(2) + "亿" : (item.volume / 1e4).toFixed(0) + "万" }
    ];
    const lineH = 17;
    const boxPadX = 9;
    const boxPadY = 7;
    const boxW = 148;
    const boxH = lines.length * lineH + boxPadY * 2;
    let bx = cx + 14;
    let by = cy - boxH / 2;
    if (bx + boxW > marginLeft + chartW) bx = cx - boxW - 14;
    bx = Math.max(marginLeft, Math.min(bx, marginLeft + chartW - boxW));
    if (by < marginTop) by = marginTop + 4;
    if (by + boxH > marginTop + priceH) by = marginTop + priceH - boxH - 4;

    ctx.save();
    ctx.fillStyle = "rgba(255,248,246,0.96)";
    ctx.strokeStyle = isUp ? "rgba(201,48,44,0.2)" : "rgba(31,139,76,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.font = "11px 'Segoe UI', 'PingFang SC', sans-serif";
    ctx.textBaseline = "alphabetic";
    lines.forEach((line, i) => {
      const ly = by + boxPadY + (i + 1) * lineH - 3;
      ctx.fillStyle = "rgba(103,112,125,0.7)";
      ctx.textAlign = "left";
      ctx.fillText(line.label, bx + boxPadX, ly);
      ctx.fillStyle = line.accent ? (isUp ? "rgba(201,48,44,0.95)" : "rgba(31,139,76,0.95)") : "rgba(22,24,29,0.9)";
      ctx.textAlign = "right";
      ctx.fillText(line.value, bx + boxW - boxPadX, ly);
    });
    ctx.restore();
  }
}

function drawLine(ctx, visible, field, color, maxPrice, minPrice, priceHeight, barWidth, marginLeft = 0, marginTop = 0) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  visible.forEach((item, index) => {
    if (item[field] == null) return;
    const x = marginLeft + index * barWidth + barWidth / 2;
    const s = Math.max(maxPrice - minPrice, 0.01);
    const y = marginTop + ((maxPrice - item[field]) / s) * (priceHeight - 2) + 1;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, y); }
  });
  ctx.stroke();
}
