import { THEME_PRESETS } from "./defaults.js";
import { escapeHtml } from "./utils.js";

export function applyTheme(settings) {
  const theme = THEME_PRESETS[settings.theme] || THEME_PRESETS.scarlet;
  const root = document.documentElement;
  root.style.setProperty("--bg-panel", theme.panel);
  root.style.setProperty("--text-main", theme.text);
  root.style.setProperty("--text-muted", theme.muted);
  root.style.setProperty("--accent-up", theme.accent);
  root.style.setProperty("--accent-down", theme.accentAlt);
  root.style.setProperty("--border-color", theme.border);
  root.style.setProperty("--panel-opacity", settings.opacity ?? 0.94);
  // 毛玻璃主题：设置标记 + 降低面板不透明度以透出背景
  if (settings.theme === "glass") {
    root.style.setProperty("--panel-opacity", Math.min(settings.opacity ?? 0.6, 0.6));
    root.style.setProperty("--bg-panel", "rgba(255, 255, 255, 0.48)");
    root.setAttribute("data-theme", "glass");
  } else {
    root.removeAttribute("data-theme");
  }
}

export function renderBadge(changePct) {
  const positive = Number(changePct) >= 0;
  return `<span class="badge ${positive ? "up" : "down"}">${positive ? "+" : ""}${Number(changePct || 0).toFixed(2)}%</span>`;
}

export function createRuleParamFields(rule = {}) {
  const period = rule.params?.period ?? 5;
  const threshold = rule.params?.threshold ?? "";
  const lookback = rule.params?.lookback ?? 12;
  const dropThreshold = rule.params?.dropThreshold ?? 3;
  const volumeRatioThreshold = rule.params?.volumeRatioThreshold ?? 1.5;

  return `
    <label class="mini-field">
      <span>周期</span>
      <input name="period" type="number" min="1" value="${escapeHtml(period)}">
    </label>
    <label class="mini-field">
      <span>阈值</span>
      <input name="threshold" type="number" step="0.1" value="${escapeHtml(threshold)}">
    </label>
    <label class="mini-field">
      <span>回看天数</span>
      <input name="lookback" type="number" min="1" value="${escapeHtml(lookback)}">
    </label>
    <label class="mini-field">
      <span>阴线跌幅%</span>
      <input name="dropThreshold" type="number" min="0" step="0.1" value="${escapeHtml(dropThreshold)}">
    </label>
    <label class="mini-field">
      <span>放量倍数</span>
      <input name="volumeRatioThreshold" type="number" min="0" step="0.1" value="${escapeHtml(volumeRatioThreshold)}">
    </label>
  `;
}

export function formatCurrency(value) {
  return Number(value || 0).toFixed(2);
}
