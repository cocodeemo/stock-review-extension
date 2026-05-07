import { compareByScoreDesc, formatDateTime, round } from "./utils.js";

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDailyReport(scoreResults, snapshots, scoreRules) {
  const sorted = [...scoreResults].sort(compareByScoreDesc);
  const totalPossibleScore = scoreRules
    .filter((rule) => rule.enabled)
    .reduce((sum, rule) => sum + Number(rule.points || 0), 0);

  const snapshotMap = Object.fromEntries(
    snapshots.map((snapshot) => [snapshot.stock.code, snapshot])
  );

  const ranking = sorted.map((item, index) => {
    const snapshot = snapshotMap[item.code];
    return {
      rank: index + 1,
      ...item,
      turnover: round(snapshot?.quote?.turnover || snapshot?.latestCandle?.turnover || 0, 2),
      volume: round(snapshot?.currentVolume || 0, 0),
      open: snapshot?.currentOpen || 0,
      high: snapshot?.quote?.high || snapshot?.latestCandle?.high || 0,
      low: snapshot?.quote?.low || snapshot?.latestCandle?.low || 0
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    generatedAtText: formatDateTime(new Date()),
    totalPossibleScore,
    ranking,
    overview: buildOverview(sorted, totalPossibleScore)
  };
}

export function buildReportNotificationMessage(report) {
  const topItems = report.ranking.slice(0, 3);
  if (!topItems.length) {
    return "当前没有自选股，先去配置列表吧。";
  }

  return topItems
    .map((item) => `${item.rank}. ${item.name} ${item.totalScore}分`)
    .join(" | ");
}

export function buildReportMarkdown(report) {
  const lines = [
    `# 每日复盘报告`,
    ``,
    `- 生成时间：${report.generatedAtText}`,
    `- 自选股数量：${report.ranking.length}`,
    `- 总分满分：${report.totalPossibleScore} 分`,
    `- 最高分：${report.overview.topScore} 分`,
    `- 平均分：${report.overview.avgScore} 分`,
    ``,
    `## 排名明细`
  ];

  report.ranking.forEach((item) => {
    lines.push(``);
    lines.push(`### ${item.rank}. ${item.name} (${item.code})`);
    lines.push(`- 得分：${item.totalScore}/${report.totalPossibleScore}`);
    lines.push(`- 现价：${item.currentPrice}`);
    lines.push(`- 涨跌幅：${item.currentChangePct}%`);
    lines.push(`- MA5：${item.ma5 ?? "--"}`);
    lines.push(`- BBI：${item.bbi ?? "--"}`);
    lines.push(`- 加分项：${item.matched.map((rule) => `${rule.ruleName}（+${rule.points}）`).join("、") || "无"}`);
    lines.push(`- 未命中项：${item.missed.map((rule) => rule.ruleName).join("、") || "无"}`);
  });

  return lines.join("\n");
}

export function buildReportHtml(report) {
  const rows = report.ranking
    .map(
      (item) => `
        <section style="border:1px solid #e5d6d1;border-radius:14px;padding:16px;margin:0 0 12px;background:#fff;">
          <h3 style="margin:0 0 10px;">${esc(item.rank)}. ${esc(item.name)} (${esc(item.code)})</h3>
          <p style="margin:4px 0;">得分：<strong>${esc(item.totalScore)}/${esc(report.totalPossibleScore)}</strong></p>
          <p style="margin:4px 0;">现价：${esc(item.currentPrice)} | 涨跌幅：${esc(item.currentChangePct)}%</p>
          <p style="margin:4px 0;">MA5：${esc(item.ma5 ?? "--")} | BBI：${esc(item.bbi ?? "--")}</p>
          <p style="margin:4px 0;">加分项：${item.matched.map((rule) => `${esc(rule.ruleName)}(+${esc(rule.points)})`).join("、") || "无"}</p>
          <p style="margin:4px 0;">未命中项：${item.missed.map((rule) => esc(rule.ruleName)).join("、") || "无"}</p>
        </section>
      `
    )
    .join("");

  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <title>每日复盘报告</title>
      </head>
      <body style="font-family:'Segoe UI','PingFang SC',sans-serif;background:#f8f4f2;color:#1b1d23;padding:24px;">
        <h1 style="margin-top:0;">每日复盘报告</h1>
        <p>生成时间：${esc(report.generatedAtText)}</p>
        <p>自选股数量：${esc(report.ranking.length)} | 满分：${esc(report.totalPossibleScore)} 分 | 最高分：${esc(report.overview.topScore)} 分 | 平均分：${esc(report.overview.avgScore)} 分</p>
        ${rows}
      </body>
    </html>
  `;
}

function buildOverview(ranking, totalPossibleScore) {
  if (!ranking.length) {
    return {
      topScore: 0,
      avgScore: 0,
      strongCount: 0,
      weakCount: 0,
      totalPossibleScore
    };
  }

  const scoreSum = ranking.reduce((sum, item) => sum + Number(item.totalScore || 0), 0);
  const avgScore = round(scoreSum / ranking.length, 2);
  const topScore = ranking[0].totalScore || 0;
  const strongThreshold = totalPossibleScore > 0 ? totalPossibleScore * 0.6 : 0;
  const weakThreshold = totalPossibleScore > 0 ? totalPossibleScore * 0.3 : 0;

  return {
    topScore,
    avgScore,
    strongCount: ranking.filter((item) => item.totalScore >= strongThreshold).length,
    weakCount: ranking.filter((item) => item.totalScore <= weakThreshold).length,
    totalPossibleScore
  };
}
