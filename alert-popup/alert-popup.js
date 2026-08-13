const params = new URLSearchParams(window.location.search);
const timeLabel = params.get("time") || "";
const threshold = params.get("threshold") || "3";
const stocksJson = params.get("stocks") || "[]";

let stocks = [];
try {
  stocks = JSON.parse(stocksJson);
} catch (error) {
  console.error("Failed to parse stocks data:", error);
}

document.getElementById("alertTitle").textContent = `盘中预警 ${timeLabel}`;
document.getElementById("alertMessage").textContent = `以下股票得分 ≤${threshold} 分：`;

const stockList = document.getElementById("stockList");
stockList.replaceChildren(
  ...stocks.map((stock) => {
    const item = document.createElement("div");
    item.className = "stock-item";
    const name = document.createElement("span");
    name.className = "stock-name";
    name.textContent = stock?.name ?? "";
    const score = document.createElement("span");
    score.className = "stock-score";
    score.textContent = `${stock?.score ?? ""}分`;
    item.append(name, score);
    return item;
  })
);

document.getElementById("closeBtn").addEventListener("click", () => {
  window.close();
});

// 用户不处理时自动关闭，避免残留预警窗口累积
setTimeout(() => window.close(), 5 * 60 * 1000);
