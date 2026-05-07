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
  const priceHeight = Math.floor(height * 0.72);
  const volumeHeight = height - priceHeight;
  const visible = candles.slice(-45);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const highs = visible.map((c) => c.high);
  const lows = visible.map((c) => c.low);
  const volumes = visible.map((c) => c.volume);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const maxVolume = Math.max(...volumes, 1);
  const barWidth = width / visible.length;

  ctx.strokeStyle = "#e9edf3";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = (priceHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  visible.forEach((item, index) => {
    const x = index * barWidth + barWidth / 2;
    const openY = mapY(item.open, maxPrice, minPrice, priceHeight);
    const closeY = mapY(item.close, maxPrice, minPrice, priceHeight);
    const highY = mapY(item.high, maxPrice, minPrice, priceHeight);
    const lowY = mapY(item.low, maxPrice, minPrice, priceHeight);
    const color = item.close >= item.open ? "#d63b2f" : "#1c8c4b";

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(Math.abs(closeY - openY), 2);
    ctx.fillStyle = color;
    ctx.fillRect(x - barWidth * 0.28, bodyY, barWidth * 0.56, bodyH);

    const volY = priceHeight + volumeHeight - (item.volume / maxVolume) * (volumeHeight - 10);
    ctx.globalAlpha = 0.42;
    ctx.fillRect(x - barWidth * 0.28, volY, barWidth * 0.56, priceHeight + volumeHeight - volY);
    ctx.globalAlpha = 1;
  });

  drawLine(ctx, visible, "ma5", "#e67e22", maxPrice, minPrice, priceHeight, barWidth);
  drawLine(ctx, visible, "bbi", "#2f6fed", maxPrice, minPrice, priceHeight, barWidth);

  ctx.fillStyle = "#5a6473";
  ctx.font = "11px Segoe UI, PingFang SC, sans-serif";
  ctx.fillText(`高 ${round(maxPrice, 2)}`, 6, 14);
  ctx.fillText(`低 ${round(minPrice, 2)}`, 6, priceHeight - 6);

  if (crosshairIndex >= 0 && crosshairIndex < visible.length) {
    const item = visible[crosshairIndex];
    const x = crosshairIndex * barWidth + barWidth / 2;
    const closeY = mapY(item.close, maxPrice, minPrice, priceHeight);

    ctx.save();
    ctx.strokeStyle = "rgba(100,120,150,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, priceHeight); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, closeY); ctx.lineTo(width, closeY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const prevClose = crosshairIndex > 0 ? visible[crosshairIndex - 1].close : item.open;
    const changePct = prevClose > 0 ? ((item.close - prevClose) / prevClose * 100) : 0;
    const sign = changePct >= 0 ? "+" : "";
    const volStr = item.turnover >= 1e8 ? `${round(item.turnover / 1e8, 2)}亿` : item.turnover >= 1e4 ? `${round(item.turnover / 1e4, 0)}万` : `${round(item.turnover, 0)}`;
    const dateStr = item.date ? String(item.date).slice(5, 10) : "";
    const label = `${dateStr}  ${round(item.close, 2)}  ${sign}${round(changePct, 2)}%  额${volStr}`;
    const padding = 5;
    ctx.font = "10px Segoe UI, PingFang SC, sans-serif";
    const textWidth = ctx.measureText(label).width;
    const boxX = Math.min(Math.max(x - textWidth / 2 - padding, 0), width - textWidth - padding * 2 - 2);
    const boxY = 2;
    ctx.fillStyle = "rgba(30,40,55,0.82)";
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, textWidth + padding * 2, 18, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(label, boxX + padding, boxY + 13);
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
  const chartHeight = Math.floor(height * 0.72);
  const volumeHeight = height - chartHeight;
  const prices = points.map((p) => p.price);
  const avgPrices = points.map((p) => p.avgPrice).filter(Boolean);
  const volumes = points.map((p) => p.volume);
  const minPrice = Math.min(...prices, ...(avgPrices.length ? avgPrices : prices), prevClose || Infinity);
  const maxPrice = Math.max(...prices, ...(avgPrices.length ? avgPrices : prices), prevClose || 0);
  const maxVolume = Math.max(...volumes, 1);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#e8edf5";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (prevClose > 0) {
    const y = mapY(prevClose, maxPrice, minPrice, chartHeight);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#9aa5b5";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawIntradaySeries(ctx, points, width, chartHeight, minPrice, maxPrice, "price", "#d63b2f");
  drawIntradaySeries(ctx, points, width, chartHeight, minPrice, maxPrice, "avgPrice", "#2f6fed");

  const barWidth = Math.max(width / points.length, 1);
  points.forEach((item, index) => {
    const x = index * barWidth;
    const barH = (item.volume / maxVolume) * (volumeHeight - 10);
    ctx.fillStyle = item.price >= prevClose ? "rgba(214,59,47,0.28)" : "rgba(28,140,75,0.28)";
    ctx.fillRect(x, height - barH, Math.max(barWidth - 1, 1), barH);
  });

  ctx.fillStyle = "#5a6473";
  ctx.font = "11px Segoe UI, PingFang SC, sans-serif";
  ctx.fillText(`高 ${round(maxPrice, 2)}`, 6, 14);
  ctx.fillText(`低 ${round(minPrice, 2)}`, 6, chartHeight - 6);
  ctx.fillText(points[0].time.slice(11, 16), 6, height - 4);
  ctx.fillText(points[points.length - 1].time.slice(11, 16), width - 38, height - 4);

  if (crosshairIndex >= 0 && crosshairIndex < points.length) {
    const item = points[crosshairIndex];
    const x = crosshairIndex * barWidth + barWidth / 2;
    const priceY = mapY(item.price, maxPrice, minPrice, chartHeight);

    ctx.save();
    ctx.strokeStyle = "rgba(100,120,150,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, chartHeight); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, priceY); ctx.lineTo(width, priceY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const changePct = prevClose > 0 ? ((item.price - prevClose) / prevClose * 100).toFixed(2) : "--";
    const sign = Number(changePct) >= 0 ? "+" : "";
    const label = `${item.time.slice(11, 16)}  ${round(item.price, 2)}  ${sign}${changePct}%`;
    const padding = 5;
    ctx.font = "10px Segoe UI, PingFang SC, sans-serif";
    const textWidth = ctx.measureText(label).width;
    const boxX = Math.min(Math.max(x - textWidth / 2 - padding, 0), width - textWidth - padding * 2 - 2);
    ctx.fillStyle = "rgba(30,40,55,0.82)";
    ctx.beginPath();
    ctx.roundRect(boxX, 2, textWidth + padding * 2, 18, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(label, boxX + padding, 15);
  }
}

function drawLine(ctx, visible, field, color, maxPrice, minPrice, priceHeight, barWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  visible.forEach((item, index) => {
    if (item[field] == null) return;
    const x = index * barWidth + barWidth / 2;
    const y = mapY(item[field], maxPrice, minPrice, priceHeight);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, y); }
  });
  ctx.stroke();
}

function drawIntradaySeries(ctx, points, width, chartHeight, minPrice, maxPrice, field, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  points.forEach((item, index) => {
    const value = item[field];
    if (value == null) return;
    const x = step * index;
    const y = mapY(value, maxPrice, minPrice, chartHeight);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, y); }
  });
  ctx.stroke();
}

function mapY(price, maxPrice, minPrice, chartHeight) {
  const spread = Math.max(maxPrice - minPrice, 0.01);
  return ((maxPrice - price) / spread) * (chartHeight - 12) + 8;
}
