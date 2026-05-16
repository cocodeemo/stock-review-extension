import { RULE_TYPES } from "../shared/defaults.js";
import {
  ensureDefaults,
  getState,
  saveAlertRules,
  saveScoreRules,
  updateSettings
} from "../shared/storage.js";
import { applyTheme, createRuleParamFields } from "../shared/ui.js";
import { escapeHtml, uid } from "../shared/utils.js";

const settingsForm = document.getElementById("settingsForm");
const holidayForm = document.getElementById("holidayForm");
const holidayList = document.getElementById("holidayList");
const alertRulesList = document.getElementById("alertRulesList");
const scoreRulesList = document.getElementById("scoreRulesList");
let editingAlertRuleId = null;
let editingScoreRuleId = null;

holidayList.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-holiday]");
  if (!btn) return;
  const st = await getState();
  const nextOverrides = (st.settings.holidayOverrides || []).filter((item) => item !== btn.dataset.holiday);
  await updateSettings({ holidayOverrides: nextOverrides });
  await render();
});

alertRulesList.addEventListener("click", async (event) => {
  await handleRuleListClick(event, "alert");
});

scoreRulesList.addEventListener("click", async (event) => {
  await handleRuleListClick(event, "score");
});

async function handleRuleListClick(event, mode) {
  const st = await getState();
  const rules = mode === "alert" ? st.alertRules : st.scoreRules;
  const saveFn = mode === "alert" ? saveAlertRules : saveScoreRules;

  const editBtn = event.target.closest(".edit-btn");
  if (editBtn) {
    if (mode === "alert") editingAlertRuleId = editBtn.dataset.id;
    else editingScoreRuleId = editBtn.dataset.id;
    await render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const toggleBtn = event.target.closest(".toggle-btn");
  if (toggleBtn) {
    const nextRules = rules.map((rule) =>
      rule.id === toggleBtn.dataset.id ? { ...rule, enabled: !rule.enabled } : rule
    );
    await saveFn(nextRules);
    await render();
    return;
  }
  const deleteBtn = event.target.closest(".delete-btn");
  if (deleteBtn) {
    const nextRules = rules.filter((rule) => rule.id !== deleteBtn.dataset.id);
    await saveFn(nextRules);
    if (mode === "alert" && editingAlertRuleId === deleteBtn.dataset.id) editingAlertRuleId = null;
    if (mode === "score" && editingScoreRuleId === deleteBtn.dataset.id) editingScoreRuleId = null;
    await render();
  }
}

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const formData = new FormData(settingsForm);
  const state = await getState();
  const settings = {
    klineDays: Math.max(30, Math.min(500, Number(formData.get("klineDays") || 60))),
    reviewReminderTime: String(formData.get("reviewReminderTime") || "15:30"),
    refreshIntervalMinutes: Math.max(1, Math.min(1440, Number(formData.get("refreshIntervalMinutes") || 5))),
    opacity: Number(formData.get("opacity") || 0.94),
    theme: String(formData.get("theme") || "scarlet"),
    reviewOnlyTradingDays: settingsForm.reviewOnlyTradingDays.checked,
    compactMode: settingsForm.compactMode.checked,
    hidePriceOnBlur: settingsForm.hidePriceOnBlur.checked,
    intradayAlertEnabled: settingsForm.intradayAlertEnabled.checked,
    intradayAlertScoreThreshold: Math.max(0, Math.min(10, Number(formData.get("intradayAlertScoreThreshold") ?? 3))),
    holidayOverrides: state.settings.holidayOverrides || []
  };
  await updateSettings(settings);
  await render();
});

holidayForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = holidayForm.holidayValue.value.trim();
  if (!value) {
    return;
  }
  const state = await getState();
  const holidayOverrides = Array.from(new Set([...(state.settings.holidayOverrides || []), value]));
  await updateSettings({ holidayOverrides });
  holidayForm.reset();
  await render();
});

render();

async function render() {
  await ensureDefaults();
  const state = await getState();
  applyTheme(state.settings);

  settingsForm.reviewReminderTime.value = state.settings.reviewReminderTime;
  settingsForm.klineDays.value = state.settings.klineDays ?? 60;
  settingsForm.refreshIntervalMinutes.value = state.settings.refreshIntervalMinutes;
  settingsForm.opacity.value = state.settings.opacity;
  settingsForm.theme.value = state.settings.theme;
  settingsForm.reviewOnlyTradingDays.checked = state.settings.reviewOnlyTradingDays;
  settingsForm.compactMode.checked = state.settings.compactMode;
  settingsForm.hidePriceOnBlur.checked = state.settings.hidePriceOnBlur;
  settingsForm.intradayAlertEnabled.checked = state.settings.intradayAlertEnabled ?? true;
  settingsForm.intradayAlertScoreThreshold.value = state.settings.intradayAlertScoreThreshold ?? 3;

  holidayList.innerHTML = (state.settings.holidayOverrides || [])
    .map(
      (item) => `
        <div class="chip">
          <span>${escapeHtml(item)}</span>
          <button class="tiny-btn" data-holiday="${escapeHtml(item)}">删除</button>
        </div>
      `
    )
    .join("");

  renderRuleComposer(
    "alertRuleForm",
    "新增预警规则",
    false,
    handleAddAlertRule,
    state.alertRules.find((item) => item.id === editingAlertRuleId)
  );
  renderRuleComposer(
    "scoreRuleForm",
    "新增打分规则",
    true,
    handleAddScoreRule,
    state.scoreRules.find((item) => item.id === editingScoreRuleId)
  );
  renderRuleList(alertRulesList, state.alertRules, false);
  renderRuleList(scoreRulesList, state.scoreRules, true);
}

function renderRuleComposer(formId, submitLabel, withPoints, onSubmit, editingRule) {
  const form = document.getElementById(formId);
  form.innerHTML = `
    <div class="rule-card">
      <div class="mini-grid">
        <input name="name" placeholder="规则名称" value="${escapeHtml(editingRule?.name || "")}" required>
        <select name="type">${RULE_TYPES.map((item) => `<option value="${escapeHtml(item.value)}" ${editingRule?.type === item.value ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select>
        ${withPoints ? `<input name="points" type="number" min="0" step="0.5" value="${escapeHtml(editingRule?.points ?? 1)}" placeholder="分值">` : ""}
        ${createRuleParamFields(editingRule)}
      </div>
      <div class="rule-row" style="margin-top: 12px;">
        <label class="check-row" style="padding-top: 0;"><input name="enabled" type="checkbox" ${editingRule?.enabled === false ? "" : "checked"}>启用规则</label>
        <button class="solid-btn" type="submit">${editingRule ? "保存修改" : escapeHtml(submitLabel)}</button>
      </div>
    </div>
  `;

  form.onsubmit = async (event) => {
    event.preventDefault();
    await onSubmit(new FormData(form));
  };
}

function buildRuleParams(formData) {
  return {
    period: Math.max(1, Math.min(200, Number(formData.get("period") || 5))),
    threshold: Math.max(0, Math.min(100, Number(formData.get("threshold") || 0))),
    lookback: Math.max(1, Math.min(250, Number(formData.get("lookback") || 12))),
    dropThreshold: Math.max(0, Math.min(100, Number(formData.get("dropThreshold") || 3))),
    volumeRatioThreshold: Math.max(0.1, Math.min(100, Number(formData.get("volumeRatioThreshold") || 1.5)))
  };
}

async function handleAddAlertRule(formData) {
  const state = await getState();
  const nextRule = {
    id: editingAlertRuleId || uid("alert"),
    name: String(formData.get("name") || "新预警"),
    type: String(formData.get("type")),
    enabled: formData.get("enabled") === "on",
    params: buildRuleParams(formData)
  };
  const nextRules = editingAlertRuleId
    ? state.alertRules.map((rule) => (rule.id === editingAlertRuleId ? nextRule : rule))
    : [nextRule, ...state.alertRules];
  await saveAlertRules(nextRules);
  editingAlertRuleId = null;
  await render();
}

async function handleAddScoreRule(formData) {
  const state = await getState();
  const nextRule = {
    id: editingScoreRuleId || uid("score"),
    name: String(formData.get("name") || "新打分项"),
    type: String(formData.get("type")),
    enabled: formData.get("enabled") === "on",
    points: Number(formData.get("points") || 1),
    params: buildRuleParams(formData)
  };
  const nextRules = editingScoreRuleId
    ? state.scoreRules.map((rule) => (rule.id === editingScoreRuleId ? nextRule : rule))
    : [nextRule, ...state.scoreRules];
  await saveScoreRules(nextRules);
  editingScoreRuleId = null;
  await render();
}

function buildParamSummary(rule) {
  const p = rule.params || {};
  const t = rule.type || "";
  const parts = [];
  const periodTypes = ["ma_above", "ma_below", "bbi_above", "bbi_below", "macd_golden_cross", "macd_death_cross", "kdj_golden_cross", "kdj_death_cross", "volume_surge", "close_above_open", "price_near_ma"];
  const thresholdTypes = ["ma_above", "ma_below", "price_near_ma"];
  const volumeTypes = ["volume_surge"];
  const dropTypes = ["consecutive_drop", "consecutive_rise"];

  if (periodTypes.includes(t) && p.period != null) parts.push(`周期 ${p.period}`);
  if (thresholdTypes.includes(t) && p.threshold != null) parts.push(`阈值 ${p.threshold}`);
  if (volumeTypes.includes(t)) {
    if (p.lookback != null) parts.push(`回看 ${p.lookback}`);
    if (p.volumeRatioThreshold != null) parts.push(`放量 ${p.volumeRatioThreshold}x`);
  }
  if (dropTypes.includes(t)) {
    if (p.lookback != null) parts.push(`回看 ${p.lookback}`);
    if (p.dropThreshold != null) parts.push(`跌幅 ${p.dropThreshold}`);
  }
  if (parts.length === 0) {
    if (p.period != null) parts.push(`周期 ${p.period}`);
    if (p.threshold != null) parts.push(`阈值 ${p.threshold}`);
    if (p.lookback != null) parts.push(`回看 ${p.lookback}`);
  }
  return parts.length ? parts.join(" / ") : "—";
}

function renderRuleList(container, rules, withPoints) {
  container.innerHTML = rules
    .map(
      (rule) => `
        <div class="rule-card">
          <div class="section-head">
            <div>
              <strong>${escapeHtml(rule.name)}</strong>
              <div class="muted">${escapeHtml(RULE_TYPES.find((item) => item.value === rule.type)?.label || rule.type)}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
              ${withPoints ? `<span>${Number(rule.points || 0)} 分</span>` : ""}
              <button class="tiny-btn edit-btn" data-id="${escapeHtml(rule.id)}">编辑</button>
              <button class="tiny-btn toggle-btn" data-id="${escapeHtml(rule.id)}">${rule.enabled ? "停用" : "启用"}</button>
              <button class="tiny-btn delete-btn" data-id="${escapeHtml(rule.id)}">删除</button>
            </div>
          </div>
          <div class="muted">${buildParamSummary(rule)}</div>
        </div>
      `
    )
    .join("");
}
