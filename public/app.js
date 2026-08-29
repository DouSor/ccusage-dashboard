'use strict';

/* ============================================================
   CCUsage Token 看板 — 前端逻辑
   数据源：/api/usage?since=YYYY-MM-DD&until=YYYY-MM-DD
   ============================================================ */

const SERIES = [
  { key: 'inputTokens',          name: 'Input' },
  { key: 'outputTokens',         name: 'Output' },
  { key: 'cacheCreationTokens',  name: 'Cache 写' },
  { key: 'cacheReadTokens',      name: 'Cache 读' },
];

/* 图表 / agent 配色按主题取值，切换主题后需重渲染 */
const CHART_THEMES = {
  dark: {
    series: {
      inputTokens: '#56b6c2',
      outputTokens: '#61afef',
      cacheCreationTokens: '#c678dd',
      cacheReadTokens: '#98c379',
    },
    agents: {
      claude: '#e0876a',
      codex: '#4ec9b0',
      opencode: '#61afef',
      hermes: '#c678dd',
      default: '#8a93a3',
    },
    axisLine: '#2a3341',
    axisLabel: '#8a93a3',
    yLabel: '#5b6574',
    splitLine: '#1c232e',
    legendText: '#8a93a3',
    inactive: '#3a4350',
    tooltipBg: '#161c25',
    tooltipBorder: '#2a3341',
    tooltipText: '#d7dde6',
    headMuted: '#8a93a3',
    total: '#4ec9b0',
    cost: '#ffb454',
    shadow: 'rgba(255, 255, 255, 0.04)',
    /* 热力图 5 档色阶：0=无数据，1~4 由浅到深 */
    heat: ['#161d2c', '#1b3358', '#2456a8', '#3d8fe0', '#8ad4ff'],
    calMonth: '#8a93a3',
    calDay: '#5b6574',
    calBorder: '#12161d',
  },
  light: {
    series: {
      inputTokens: '#257082',
      outputTokens: '#2f639c',
      cacheCreationTokens: '#8a47b8',
      cacheReadTokens: '#55822f',
    },
    agents: {
      claude: '#b85c38',
      codex: '#1f7a65',
      opencode: '#2f639c',
      hermes: '#8a47b8',
      default: '#7c7565',
    },
    axisLine: '#cec5ae',
    axisLabel: '#7c7565',
    yLabel: '#a89f8c',
    splitLine: '#e0d8c8',
    legendText: '#7c7565',
    inactive: '#c6bda9',
    tooltipBg: '#fcfaf5',
    tooltipBorder: '#cec5ae',
    tooltipText: '#3b362c',
    headMuted: '#7c7565',
    total: '#1f7a65',
    cost: '#b26f14',
    shadow: 'rgba(0, 0, 0, 0.06)',
    heat: ['#e8ecf1', '#c3d6ea', '#8fb8e0', '#4a88c8', '#1d5fa8'],
    calMonth: '#7c7565',
    calDay: '#a89f8c',
    calBorder: '#f6f3ec',
  },
};

function chartTheme() {
  return CHART_THEMES[settings.theme] || CHART_THEMES.dark;
}

const MONO_FONT = '"Cascadia Code", "Cascadia Mono", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace';

/* ---------------- 设置（主题 / 单位，localStorage 持久化） ---------------- */

const SETTINGS_KEY = 'ccusage-dashboard-settings';

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      theme: raw.theme === 'light' ? 'light' : 'dark',
      unit: ['mb', 'decimal', 'cn'].includes(raw.unit) ? raw.unit : 'mb',
    };
  } catch {
    return { theme: 'dark', unit: 'mb' };
  }
}

const settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* 存储不可用时静默降级为会话内生效 */ }
}

const state = {
  since: null,
  until: null,
  mode: 'absolute',   // absolute | percent
  data: null,
  heatmap: null,      // 独立于筛选：固定近 30 天
  reqId: 0,
};

let chart = null;
let heatmapChart = null;
let toastTimer = null;

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);
const els = {
  statusDot: $('statusDot'),
  lastUpdated: $('lastUpdated'),
  refreshBtn: $('refreshBtn'),
  settingsBtn: $('settingsBtn'),
  settingsPanel: $('settingsPanel'),
  themeToggle: $('themeToggle'),
  unitToggle: $('unitToggle'),
  presets: $('presets'),
  sinceInput: $('sinceInput'),
  untilInput: $('untilInput'),
  applyBtn: $('applyBtn'),
  rangeLabel: $('rangeLabel'),
  chart: $('chart'),
  chartEmpty: $('chartEmpty'),
  chartTitle: $('chartTitle'),
  heatmap: $('heatmap'),
  heatmapEmpty: $('heatmapEmpty'),
  heatmapTitle: $('heatmapTitle'),
  stackToggle: $('stackToggle'),
  tableBody: $('tableBody'),
  tableFoot: $('tableFoot'),
  tableSub: $('tableSub'),
  toast: $('toast'),
  cards: {
    total: $('vTotal'), totalSub: $('vTotalSub'),
    cost: $('vCost'), costSub: $('vCostSub'),
    input: $('vInput'), output: $('vOutput'),
    cacheCreate: $('vCacheCreate'), cacheRead: $('vCacheRead'),
  },
  bars: { input: $('bInput'), output: $('bOutput'), cacheCreate: $('bCacheCreate'), cacheRead: $('bCacheRead') },
};

/* ---------------- 工具函数 ---------------- */

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayStr() { return fmtDate(new Date()); }

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function inclusiveDays(since, until) {
  return Math.round((new Date(`${until}T00:00:00`) - new Date(`${since}T00:00:00`)) / 86400000) + 1;
}

function fmtCompact(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);

  if (settings.unit === 'cn') {
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
    if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
    return String(n);
  }

  const suffix = settings.unit === 'decimal'
    ? { k: '千', m: '百万', b: '十亿' }
    : { k: 'K', m: 'M', b: 'B' };
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}${suffix.b}`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}${suffix.m}`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}${suffix.k}`;
  return String(n);
}

function fmtFull(n) { return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'; }

function fmtCost(n) { return `$${Number.isFinite(n) ? n.toFixed(2) : '0.00'}`; }

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}

function agentInfo(name) {
  const key = String(name || '').toLowerCase();
  const t = chartTheme();
  const label = key ? key[0].toUpperCase() + key.slice(1) : 'unknown';
  return { label, color: t.agents[key] || t.agents.default };
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 4200);
}

function setStatus(status) {
  document.body.dataset.status = status;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 数字滚动动画（后台标签页 rAF 会被暂停，用定时器兜底保证最终值） */
function animateNumber(el, target, formatter) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = target;
  cancelAnimationFrame(Number(el.dataset.raf || 0));
  clearTimeout(Number(el.dataset.tmr || 0));
  const start = performance.now();
  const duration = 600;
  const finalText = formatter(target);
  const step = (t) => {
    const k = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = formatter(from + (target - from) * eased);
    if (k < 1) el.dataset.raf = String(requestAnimationFrame(step));
  };
  el.dataset.raf = String(requestAnimationFrame(step));
  el.dataset.tmr = String(setTimeout(() => { el.textContent = finalText; }, duration + 80));
}

/* ---------------- 日期范围 ---------------- */

function presetRange(name) {
  const t = todayStr();
  switch (name) {
    case 'today': return [t, t];
    case 'yesterday': { const s = fmtDate(addDays(new Date(), -1)); return [s, s]; }
    case 'last7': return [fmtDate(addDays(new Date(), -6)), t];
    case 'last30': return [fmtDate(addDays(new Date(), -29)), t];
    case 'month': return [`${t.slice(0, 7)}-01`, t];
    default: return null;
  }
}

function presetNameOf(since, until) {
  for (const btn of els.presets.querySelectorAll('.preset-btn')) {
    const [s, u] = presetRange(btn.dataset.preset);
    if (s === since && u === until) return btn.dataset.preset;
  }
  return null;
}

const PRESET_LABEL = { today: '今天', yesterday: '昨天', last7: '近 7 天', last30: '近 30 天', month: '本月' };

function setRange(since, until) {
  state.since = since;
  state.until = until;
  els.sinceInput.value = since;
  els.untilInput.value = until;

  const preset = presetNameOf(since, until);
  for (const btn of els.presets.querySelectorAll('.preset-btn')) {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  }

  const days = inclusiveDays(since, until);
  const label = days === 1 ? since : `${since} → ${until} · ${days} 天`;
  const prefix = preset ? PRESET_LABEL[preset] : '自定义';
  els.rangeLabel.textContent = `${prefix} · ${label}`;

  load();
}

/* ---------------- 数据加载 ---------------- */

async function load() {
  const id = ++state.reqId;
  setStatus('loading');
  els.refreshBtn.disabled = true;

  try {
    const res = await fetch(`/api/usage?since=${state.since}&until=${state.until}`);
    const json = await res.json();
    if (id !== state.reqId) return;

    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

    state.data = json;
    render();
    setStatus('ok');

    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    els.lastUpdated.textContent = `更新于 ${time} · ${json.durationMs}ms`;
  } catch (err) {
    if (id !== state.reqId) return;
    setStatus('error');
    showToast(`获取数据失败：${err.message}`);
  } finally {
    if (id === state.reqId) els.refreshBtn.disabled = false;
  }
}

/* ---------------- 热力图（固定近 30 天，不受筛选影响） ---------------- */

const HEATMAP_DAYS = 180;

async function loadHeatmap() {
  const until = todayStr();
  const since = fmtDate(addDays(new Date(), -(HEATMAP_DAYS - 1)));
  try {
    const res = await fetch(`/api/usage?since=${since}&until=${until}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    state.heatmap = { since, until, daily: json.report?.daily || [] };
    renderHeatmap();
  } catch (err) {
    showToast(`热力图数据获取失败：${err.message}`);
  }
}

function renderHeatmap() {
  const hm = state.heatmap;
  if (!hm) return;

  const byDay = new Map();
  for (const day of hm.daily) {
    byDay.set(day.period, { tokens: day.totalTokens || 0, cost: day.totalCost || 0 });
  }

  // 填满整个 30 天窗口，无数据日记 0
  const rows = [];
  let max = 0;
  for (let i = 0; i < HEATMAP_DAYS; i++) {
    const date = fmtDate(addDays(new Date(`${hm.since}T00:00:00`), i));
    const info = byDay.get(date) || { tokens: 0, cost: 0 };
    if (info.tokens > max) max = info.tokens;
    rows.push({ date, ...info });
  }

  els.heatmapTitle.textContent = `近 180 天热力图 · ${hm.since} → ${hm.until}`;

  const empty = max === 0;
  els.heatmapEmpty.hidden = !empty;
  if (empty) return;

  const t = chartTheme();
  // 量化为 5 档：0=无数据，1~4 按占最大值比例
  const levelOf = (v) => (v <= 0 ? 0 : Math.min(4, Math.floor((v / max) * 4) + 1));
  const data = rows.map((r) => ({
    value: [r.date, levelOf(r.tokens)],
    tokens: r.tokens,
    cost: r.cost,
  }));

  const option = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: MONO_FONT },
    tooltip: {
      trigger: 'item',
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: t.tooltipText, fontSize: 12, fontFamily: MONO_FONT },
      formatter: (p) => {
        const d = p.data;
        let html = `<div style="margin-bottom:6px;color:${t.headMuted}">${escapeHtml(d.value[0])} ${weekdayOf(d.value[0])}</div>`;
        html += `Token&nbsp;&nbsp;<b style="color:${t.total}">${fmtCompact(d.tokens)}</b>`;
        if (d.cost > 0) html += `<br>费用&nbsp;&nbsp;<b style="color:${t.cost}">${fmtCost(d.cost)}</b>`;
        if (d.tokens <= 0) html += `<br><span style="color:${t.headMuted}">无用量记录</span>`;
        return html;
      },
    },
    visualMap: {
      show: false,
      type: 'piecewise',
      seriesIndex: 0,
      pieces: t.heat.map((color, level) => ({ min: level, max: level, color })),
    },
    calendar: {
      top: 34,
      left: 46,
      right: 12,
      cellSize: ['auto', 28],
      range: [hm.since, hm.until],
      splitLine: { show: false },
      itemStyle: { color: 'transparent', borderWidth: 3, borderColor: t.calBorder, borderRadius: 4 },
      yearLabel: { show: false },
      monthLabel: {
        color: t.calMonth,
        fontSize: 11,
        fontFamily: MONO_FONT,
        margin: 8,
        nameMap: 'cn',
      },
      dayLabel: {
        color: t.calDay,
        fontSize: 10.5,
        fontFamily: MONO_FONT,
        margin: 6,
        firstDay: 1,
        nameMap: ['日', '一', '二', '三', '四', '五', '六'],
      },
    },
    series: [{
      type: 'heatmap',
      coordinateSystem: 'calendar',
      data,
    }],
    animationDuration: 400,
  };

  if (!heatmapChart) heatmapChart = echarts.init(els.heatmap);
  heatmapChart.setOption(option, { notMerge: true });
}

function applyHeatLegendColors() {
  const t = chartTheme();
  for (const box of document.querySelectorAll('#heatmapLegend .legend-box')) {
    box.style.background = t.heat[Number(box.dataset.level)] || t.heat[0];
  }
}

/* ---------------- 渲染 ---------------- */

function render() {
  const report = state.data.report || {};
  const daily = report.daily || [];
  const totals = report.totals || {};

  renderCards(totals, daily);
  renderChart(daily);
  renderTable(daily, totals);
}

function renderCards(totals, daily) {
  const { cards, bars } = els;
  const totalTokens = totals.totalTokens || 0;
  const days = daily.length;

  animateNumber(cards.total, totalTokens, fmtCompact);
  cards.total.title = fmtFull(totalTokens);
  cards.totalSub.textContent = days ? `${fmtFull(totalTokens)} tokens${days > 1 ? ` · ${days} 天` : ''}` : '无数据';

  const cost = totals.totalCost || 0;
  animateNumber(cards.cost, cost, fmtCost);
  cards.cost.title = `$${cost.toFixed(4)}`;
  cards.costSub.textContent = days ? (days > 1 ? `日均 ${fmtCost(cost / days)}` : '单日合计') : '无数据';

  const values = {
    input: totals.inputTokens || 0,
    output: totals.outputTokens || 0,
    cacheCreate: totals.cacheCreationTokens || 0,
    cacheRead: totals.cacheReadTokens || 0,
  };

  animateNumber(cards.input, values.input, fmtCompact);
  animateNumber(cards.output, values.output, fmtCompact);
  animateNumber(cards.cacheCreate, values.cacheCreate, fmtCompact);
  animateNumber(cards.cacheRead, values.cacheRead, fmtCompact);

  const share = (v) => (totalTokens > 0 ? Math.min(100, (v / totalTokens) * 100) : 0);
  bars.input.style.width = `${share(values.input)}%`;
  bars.output.style.width = `${share(values.output)}%`;
  bars.cacheCreate.style.width = `${share(values.cacheCreate)}%`;
  bars.cacheRead.style.width = `${share(values.cacheRead)}%`;

  cards.input.title = fmtFull(values.input);
  cards.output.title = fmtFull(values.output);
  cards.cacheCreate.title = fmtFull(values.cacheCreate);
  cards.cacheRead.title = fmtFull(values.cacheRead);
}

function renderChart(daily) {
  const single = daily.length === 1;
  els.chartTitle.textContent = single
    ? `模型分布 · ${daily[0].period}`
    : '按日 Token 用量';

  if (!daily.length) {
    els.chartEmpty.hidden = false;
    if (chart) chart.clear();
    return;
  }
  els.chartEmpty.hidden = true;

  const sorted = [...daily].sort((a, b) => a.period.localeCompare(b.period));

  let categories;
  let rows;
  let costLookup;

  if (single) {
    rows = [...(daily[0].modelBreakdowns || [])].sort((a, b) => sumTokens(b) - sumTokens(a));
    categories = rows.map((r) => r.modelName);
    costLookup = new Map(rows.map((r) => [r.modelName, r.cost]));
  } else {
    rows = sorted;
    categories = sorted.map((r) => r.period);
    costLookup = new Map(sorted.map((r) => [r.period, r.totalCost]));
  }

  const totalLookup = new Map(rows.map((r) => [single ? r.modelName : r.period, sumTokens(r)]));

  const toValue = (row, key) => (state.mode === 'percent'
    ? (() => { const t = sumTokens(row); return t > 0 ? (row[key] / t) * 100 : 0; })()
    : row[key] || 0);

  const t = chartTheme();

  const series = SERIES.map((s) => ({
    name: s.name,
    type: 'bar',
    stack: 'tokens',
    barMaxWidth: 42,
    itemStyle: { color: t.series[s.key], borderRadius: single ? [0, 0, 0, 0] : [0, 0, 0, 0] },
    emphasis: { itemStyle: { opacity: 0.85 } },
    data: rows.map((r) => +toValue(r, s.key).toFixed(2)),
  }));

  const option = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: MONO_FONT },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: t.shadow } },
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: t.tooltipText, fontSize: 12, fontFamily: MONO_FONT },
      formatter: (params) => {
        const name = params[0].axisValue;
        const head = single ? name : `${name} ${weekdayOf(name)}`;
        const lines = params
          .filter((p) => p.value > 0)
          .map((p) => `${p.marker} ${p.seriesName}  ${state.mode === 'percent' ? `${p.value.toFixed(1)}%` : fmtCompact(p.value)}`);
        let html = `<div style="margin-bottom:6px;color:${t.headMuted}">${escapeHtml(head)}</div>`;
        html += lines.length ? lines.join('<br>') : '无数据';
        if (state.mode === 'absolute') {
          const total = totalLookup.get(name);
          const cost = costLookup.get(name);
          html += `<div style="border-top:1px solid ${t.tooltipBorder};margin-top:8px;padding-top:7px">`
            + `合计 <b style="color:${t.total}">${fmtCompact(total || 0)}</b>`
            + `&nbsp;&nbsp;费用 <b style="color:${t.cost}">${fmtCost(cost || 0)}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      top: 0,
      right: 4,
      icon: 'rect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      textStyle: { color: t.legendText, fontSize: 11, fontFamily: MONO_FONT },
      inactiveColor: t.inactive,
    },
    grid: { left: 10, right: 14, top: 38, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: t.axisLine } },
      axisTick: { show: false },
      axisLabel: {
        color: t.axisLabel,
        fontSize: 11,
        fontFamily: MONO_FONT,
        interval: 0,
        formatter: (v) => (single
          ? (v.length > 16 ? `${v.slice(0, 15)}…` : v)
          : `${v.slice(5)}\n${weekdayOf(v)}`),
      },
    },
    yAxis: {
      type: 'value',
      max: state.mode === 'percent' ? 100 : null,
      axisLabel: {
        color: t.yLabel,
        fontSize: 11,
        fontFamily: MONO_FONT,
        formatter: (v) => (state.mode === 'percent' ? `${v}%` : fmtCompact(v)),
      },
      splitLine: { lineStyle: { color: t.splitLine, type: 'dashed' } },
    },
    color: SERIES.map((s) => t.series[s.key]),
    series,
    animationDuration: 500,
    animationEasing: 'cubicOut',
  };

  if (!chart) chart = echarts.init(els.chart);
  chart.setOption(option, { notMerge: true });
}

function sumTokens(row) {
  return (row.inputTokens || 0) + (row.outputTokens || 0)
    + (row.cacheCreationTokens || 0) + (row.cacheReadTokens || 0);
}

function renderTable(daily, totals) {
  // 按选定范围整体聚合：agent × 模型 一行，不分天
  const agentNames = new Set();
  const agg = new Map();

  for (const day of daily) {
    const agentEntries = (day.agents && day.agents.length)
      ? day.agents
      : [{ agent: (day.metadata?.agents || []).join('/') || 'all', modelBreakdowns: day.modelBreakdowns }];

    for (const agentEntry of agentEntries) {
      agentNames.add(agentEntry.agent);
      for (const mb of agentEntry.modelBreakdowns || []) {
        const key = `${agentEntry.agent}|||${mb.modelName}`;
        const cur = agg.get(key) || {
          agent: agentEntry.agent,
          model: mb.modelName,
          input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0,
        };
        cur.input += mb.inputTokens || 0;
        cur.output += mb.outputTokens || 0;
        cur.cacheCreate += mb.cacheCreationTokens || 0;
        cur.cacheRead += mb.cacheReadTokens || 0;
        cur.cost += mb.cost || 0;
        agg.set(key, cur);
      }
    }
  }

  const rows = [...agg.values()]
    .map((r) => ({ ...r, total: r.input + r.output + r.cacheCreate + r.cacheRead }))
    .sort((a, b) => b.total - a.total);

  const agentList = [...agentNames].map(agentInfo);
  els.tableSub.textContent = rows.length
    ? `${rows.length} 行 · ${agentList.map((a) => a.label).join(' / ')} · 覆盖 ${daily.length} 天`
    : '—';

  if (!rows.length) {
    els.tableBody.innerHTML = `<tr class="table-empty-row"><td colspan="8">该时间范围内没有用量记录</td></tr>`;
    els.tableFoot.innerHTML = '';
    return;
  }

  const numCell = (v, full) => `<td class="num" title="${escapeHtml(full)}">${fmtCompact(v)}</td>`;
  const costCell = (v, full) => `<td class="num" title="${escapeHtml(full)}">${fmtCost(v)}</td>`;

  els.tableBody.innerHTML = rows.map((r) => {
    const a = agentInfo(r.agent);
    return `<tr>`
      + `<td><span class="agent-chip" style="color:${a.color}">${escapeHtml(a.label)}</span></td>`
      + `<td>${escapeHtml(r.model)}</td>`
      + numCell(r.input, fmtFull(r.input))
      + numCell(r.output, fmtFull(r.output))
      + numCell(r.cacheCreate, fmtFull(r.cacheCreate))
      + numCell(r.cacheRead, fmtFull(r.cacheRead))
      + numCell(r.total, fmtFull(r.total))
      + costCell(r.cost, `$${r.cost.toFixed(4)}`)
      + `</tr>`;
  }).join('');

  const t = totals || {};
  els.tableFoot.innerHTML = `<tr>`
    + `<td class="total-label" colspan="2">合计</td>`
    + numCell(t.inputTokens || 0, fmtFull(t.inputTokens || 0))
    + numCell(t.outputTokens || 0, fmtFull(t.outputTokens || 0))
    + numCell(t.cacheCreationTokens || 0, fmtFull(t.cacheCreationTokens || 0))
    + numCell(t.cacheReadTokens || 0, fmtFull(t.cacheReadTokens || 0))
    + numCell(t.totalTokens || 0, fmtFull(t.totalTokens || 0))
    + costCell(t.totalCost || 0, `$${(t.totalCost || 0).toFixed(4)}`)
    + `</tr>`;
}

/* ---------------- 事件 ---------------- */

els.presets.addEventListener('click', (e) => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  const range = presetRange(btn.dataset.preset);
  if (range) setRange(range[0], range[1]);
});

function applyCustomRange() {
  const since = els.sinceInput.value;
  const until = els.untilInput.value;
  if (!since || !until) { showToast('请先选择开始与结束日期'); return; }
  if (since > until) { showToast('开始日期不能晚于结束日期'); return; }
  setRange(since, until);
}

els.applyBtn.addEventListener('click', applyCustomRange);
els.sinceInput.addEventListener('change', applyCustomRange);
els.untilInput.addEventListener('change', applyCustomRange);
els.sinceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustomRange(); });
els.untilInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustomRange(); });

els.refreshBtn.addEventListener('click', () => { load(); loadHeatmap(); });

/* ---------------- 设置面板 ---------------- */

function closeSettingsPanel() {
  els.settingsPanel.classList.remove('open');
  els.settingsBtn.setAttribute('aria-expanded', 'false');
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  for (const b of els.themeToggle.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b.dataset.theme === settings.theme);
  }
  applyHeatLegendColors();
  if (state.heatmap) renderHeatmap();
}

function applyUnit() {
  for (const b of els.unitToggle.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b.dataset.unit === settings.unit);
  }
}

els.settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.settingsPanel.classList.toggle('open');
  els.settingsBtn.setAttribute('aria-expanded', String(open));
});

document.addEventListener('click', (e) => {
  if (!els.settingsPanel.classList.contains('open')) return;
  if (els.settingsPanel.contains(e.target)) return;
  closeSettingsPanel();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettingsPanel();
});

els.themeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || btn.dataset.theme === settings.theme) return;
  settings.theme = btn.dataset.theme;
  saveSettings();
  applyTheme();
  if (state.data) render();
});

els.unitToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || btn.dataset.unit === settings.unit) return;
  settings.unit = btn.dataset.unit;
  saveSettings();
  applyUnit();
  if (state.data) render();
});

els.stackToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || btn.dataset.mode === state.mode) return;
  state.mode = btn.dataset.mode;
  for (const b of els.stackToggle.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === btn);
  }
  if (state.data) renderChart(state.data.report?.daily || []);
});

window.addEventListener('resize', () => {
  if (chart) chart.resize();
  if (heatmapChart) heatmapChart.resize();
});

/* ---------------- 启动 ---------------- */

applyTheme();
applyUnit();
setRange(todayStr(), todayStr());
loadHeatmap();
