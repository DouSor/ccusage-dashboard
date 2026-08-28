'use strict';

/* ============================================================
   CCUsage Token 看板 — 前端逻辑
   数据源：/api/usage?since=YYYY-MM-DD&until=YYYY-MM-DD
   ============================================================ */

const SERIES = [
  { key: 'inputTokens',          name: 'Input',    color: '#56b6c2' },
  { key: 'outputTokens',         name: 'Output',   color: '#61afef' },
  { key: 'cacheCreationTokens',  name: 'Cache 写', color: '#c678dd' },
  { key: 'cacheReadTokens',      name: 'Cache 读', color: '#98c379' },
];

const AGENT_STYLE = {
  claude:   { label: 'Claude',   color: '#e0876a' },
  codex:    { label: 'Codex',    color: '#4ec9b0' },
  opencode: { label: 'OpenCode', color: '#61afef' },
  hermes:   { label: 'Hermes',   color: '#c678dd' },
};

const MONO_FONT = '"Cascadia Code", "Cascadia Mono", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace';

const state = {
  since: null,
  until: null,
  mode: 'absolute',   // absolute | percent
  data: null,
  reqId: 0,
};

let chart = null;
let toastTimer = null;

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);
const els = {
  statusDot: $('statusDot'),
  lastUpdated: $('lastUpdated'),
  refreshBtn: $('refreshBtn'),
  presets: $('presets'),
  sinceInput: $('sinceInput'),
  untilInput: $('untilInput'),
  applyBtn: $('applyBtn'),
  rangeLabel: $('rangeLabel'),
  chart: $('chart'),
  chartEmpty: $('chartEmpty'),
  chartTitle: $('chartTitle'),
  stackToggle: $('stackToggle'),
  tableBody: $('tableBody'),
  tableFoot: $('tableFoot'),
  tableSub: $('tableSub'),
  table: $('detailTable'),
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
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtFull(n) { return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'; }

function fmtCost(n) { return `$${Number.isFinite(n) ? n.toFixed(2) : '0.00'}`; }

function agentInfo(name) {
  const key = String(name || '').toLowerCase();
  if (AGENT_STYLE[key]) return AGENT_STYLE[key];
  return { label: key ? key[0].toUpperCase() + key.slice(1) : 'unknown', color: '#8a93a3' };
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

  const series = SERIES.map((s) => ({
    name: s.name,
    type: 'bar',
    stack: 'tokens',
    barMaxWidth: 42,
    itemStyle: { color: s.color, borderRadius: single ? [0, 0, 0, 0] : [0, 0, 0, 0] },
    emphasis: { itemStyle: { opacity: 0.85 } },
    data: rows.map((r) => +toValue(r, s.key).toFixed(2)),
  }));

  const option = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: MONO_FONT },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.04)' } },
      backgroundColor: '#161c25',
      borderColor: '#2a3341',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: '#d7dde6', fontSize: 12, fontFamily: MONO_FONT },
      formatter: (params) => {
        const name = params[0].axisValue;
        const lines = params
          .filter((p) => p.value > 0)
          .map((p) => `${p.marker} ${p.seriesName}  ${state.mode === 'percent' ? `${p.value.toFixed(1)}%` : fmtCompact(p.value)}`);
        let html = `<div style="margin-bottom:6px;color:#8a93a3">${escapeHtml(name)}</div>`;
        html += lines.length ? lines.join('<br>') : '无数据';
        if (state.mode === 'absolute') {
          const total = totalLookup.get(name);
          const cost = costLookup.get(name);
          html += `<div style="border-top:1px solid #2a3341;margin-top:8px;padding-top:7px">`
            + `合计 <b style="color:#4ec9b0">${fmtCompact(total || 0)}</b>`
            + `&nbsp;&nbsp;费用 <b style="color:#ffb454">${fmtCost(cost || 0)}</b></div>`;
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
      textStyle: { color: '#8a93a3', fontSize: 11, fontFamily: MONO_FONT },
      inactiveColor: '#3a4350',
    },
    grid: { left: 10, right: 14, top: 38, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: '#2a3341' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#8a93a3',
        fontSize: 11,
        fontFamily: MONO_FONT,
        rotate: categories.length > 8 || single ? 0 : 0,
        interval: 0,
        formatter: (v) => (v.length > 16 ? `${v.slice(0, 15)}…` : v),
      },
    },
    yAxis: {
      type: 'value',
      max: state.mode === 'percent' ? 100 : null,
      axisLabel: {
        color: '#5b6574',
        fontSize: 11,
        fontFamily: MONO_FONT,
        formatter: (v) => (state.mode === 'percent' ? `${v}%` : fmtCompact(v)),
      },
      splitLine: { lineStyle: { color: '#1c232e', type: 'dashed' } },
    },
    color: SERIES.map((s) => s.color),
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
  const sorted = [...daily].sort((a, b) => b.period.localeCompare(a.period));
  els.table.classList.toggle('single-day', sorted.length === 1);

  const agentNames = new Set();
  const rows = [];

  for (const day of sorted) {
    const agentEntries = (day.agents && day.agents.length)
      ? day.agents
      : [{ agent: (day.metadata?.agents || []).join('/') || 'all', modelBreakdowns: day.modelBreakdowns }];

    for (const agentEntry of agentEntries) {
      agentNames.add(agentEntry.agent);
      const models = [...(agentEntry.modelBreakdowns || [])].sort((a, b) => sumTokens(b) - sumTokens(a));
      for (const mb of models) {
        rows.push({
          date: day.period,
          agent: agentEntry.agent,
          model: mb.modelName,
          input: mb.inputTokens || 0,
          output: mb.outputTokens || 0,
          cacheCreate: mb.cacheCreationTokens || 0,
          cacheRead: mb.cacheReadTokens || 0,
          cost: mb.cost || 0,
        });
      }
    }
  }

  const agentList = [...agentNames].map(agentInfo);
  els.tableSub.textContent = rows.length
    ? `${rows.length} 行 · ${agentList.map((a) => a.label).join(' / ')} · ${sorted.length} 天`
    : '—';

  if (!rows.length) {
    els.tableBody.innerHTML = `<tr class="table-empty-row"><td colspan="9">该时间范围内没有用量记录</td></tr>`;
    els.tableFoot.innerHTML = '';
    return;
  }

  const numCell = (v, full) => `<td class="num" title="${escapeHtml(full)}">${fmtCompact(v)}</td>`;
  const costCell = (v, full) => `<td class="num" title="${escapeHtml(full)}">${fmtCost(v)}</td>`;

  els.tableBody.innerHTML = rows.map((r) => {
    const a = agentInfo(r.agent);
    const total = r.input + r.output + r.cacheCreate + r.cacheRead;
    return `<tr>`
      + `<td class="col-date">${r.date}</td>`
      + `<td><span class="agent-chip" style="color:${a.color}">${escapeHtml(a.label)}</span></td>`
      + `<td>${escapeHtml(r.model)}</td>`
      + numCell(r.input, fmtFull(r.input))
      + numCell(r.output, fmtFull(r.output))
      + numCell(r.cacheCreate, fmtFull(r.cacheCreate))
      + numCell(r.cacheRead, fmtFull(r.cacheRead))
      + numCell(total, fmtFull(total))
      + costCell(r.cost, `$${r.cost.toFixed(4)}`)
      + `</tr>`;
  }).join('');

  const t = totals || {};
  els.tableFoot.innerHTML = `<tr>`
    + `<td class="col-date"></td>`
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

els.refreshBtn.addEventListener('click', () => load());

els.stackToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || btn.dataset.mode === state.mode) return;
  state.mode = btn.dataset.mode;
  for (const b of els.stackToggle.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === btn);
  }
  if (state.data) renderChart(state.data.report?.daily || []);
});

window.addEventListener('resize', () => { if (chart) chart.resize(); });

/* ---------------- 启动 ---------------- */

setRange(todayStr(), todayStr());
