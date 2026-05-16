const params = new URLSearchParams(window.location.search);
const timeLabel = params.get("time") || "";
const threshold = params.get("threshold") || "3";
const stocksJson = params.get("stocks") || "[]";

let stocks = [];
try {
  stocks = JSON.parse(decodeURIComponent(stocksJson));
} catch (error) {
  console.error("Failed to parse stocks data:", error);
}

document.getElementById("alertTitle").textContent = `盘中预警 ${timeLabel}`;
document.getElementById("alertMessage").textContent = `以下股票得分 ≤${threshold} 分：`;

const stockList = document.getElementById("stockList");
stockList.innerHTML = stocks
  .map(
    (stock) => `
      <div class="stock-item">
        <span class="stock-name">${stock.name}</span>
        <span class="stock-score">${stock.score}分</span>
      </div>
    `
  )
  .join("");

document.getElementById("closeBtn").addEventListener("click", () => {
  window.close();
});
