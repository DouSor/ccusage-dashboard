'use strict';

/**
 * 解析 MiniMax Code 本地会话记录，产出与 ccusage `daily --json --by-agent`
 * 同构的用量数据，供 /api/usage 合并。
 *
 * 数据源：~/.minimax/v2/sessions/日期目录/messages.jsonl（按 YYYY/MM/DD 分层）。
 * 只有 role=assistant 的行携带 message.usage，口径为分列式
 * （input 不含缓存，四项相加 = 总量），与 ccusage 一致，直接映射：
 *   input→inputTokens, output→outputTokens, cacheWrite→cacheCreationTokens, cacheRead→cacheReadTokens
 * usage.cost 恒为 0（订阅计费），成本走可选 prices.json。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPrices, modelCost } = require('./prices');

const MINIMAX_AGENT = 'minimax';
const SESSIONS_DIR = path.join(os.homedir(), '.minimax', 'v2', 'sessions');

function pad2(n) { return String(n).padStart(2, '0'); }

/* epoch 毫秒 → 本地日期 YYYY-MM-DD */
function msToLocalDate(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* 单行记录 → 分量映射；非 assistant 行/无 usage/坏行返回 null */
function parseLine(line) {
  if (!line.trim()) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // 文件实时写入中，容忍半行
  }
  const msg = entry?.message;
  const usage = msg?.usage;
  if (!msg || !usage || msg.role !== 'assistant') return null;

  const date = msToLocalDate(msg.timestamp);
  if (!date) return null;

  const inputTokens = usage.input || 0;
  const outputTokens = usage.output || 0;
  const cacheCreationTokens = usage.cacheWrite || 0;
  const cacheReadTokens = usage.cacheRead || 0;

  return {
    date,
    model: msg.model || 'unknown',
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
  };
}

/* 递归收集 sessions 目录下所有 messages.jsonl */
function listSessionFiles() {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 未安装 MiniMax Code 或目录不存在
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(full, depth + 1); // YYYY/MM/DD/session_xxx 四层
      } else if (e.name === 'messages.jsonl') {
        files.push(full);
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return files;
}

function collectMinimaxUsage(since, until) {
  const prices = loadPrices();
  const days = new Map();

  for (const file of listSessionFiles()) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 文件可能正被独占写入
    }

    for (const line of content.split('\n')) {
      const rec = parseLine(line);
      if (!rec || rec.date < since || rec.date > until) continue;

      let day = days.get(rec.date);
      if (!day) {
        day = { tokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 }, models: new Map() };
        days.set(rec.date, day);
      }

      let mb = day.models.get(rec.model);
      if (!mb) {
        mb = {
          modelName: rec.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
        };
        day.models.set(rec.model, mb);
      }
      mb.inputTokens += rec.inputTokens;
      mb.outputTokens += rec.outputTokens;
      mb.cacheCreationTokens += rec.cacheCreationTokens;
      mb.cacheReadTokens += rec.cacheReadTokens;
      mb.cost = modelCost(prices, rec.model, mb);

      day.tokens.inputTokens += rec.inputTokens;
      day.tokens.outputTokens += rec.outputTokens;
      day.tokens.cacheCreationTokens += rec.cacheCreationTokens;
      day.tokens.cacheReadTokens += rec.cacheReadTokens;
      day.tokens.totalTokens += rec.totalTokens;
    }
  }

  const daily = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, day]) => {
      const modelBreakdowns = [...day.models.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
      const dayCost = modelBreakdowns.reduce((s, m) => s + m.cost, 0);
      const agentEntry = {
        agent: MINIMAX_AGENT,
        ...day.tokens,
        totalCost: dayCost,
        modelsUsed: modelBreakdowns.map((m) => m.modelName),
        modelBreakdowns,
      };
      return {
        period,
        agent: 'all',
        ...day.tokens,
        totalCost: dayCost,
        modelsUsed: agentEntry.modelsUsed,
        modelBreakdowns,
        metadata: { agents: [MINIMAX_AGENT] },
        agents: [agentEntry],
      };
    });

  const totals = daily.reduce((acc, d) => ({
    inputTokens: acc.inputTokens + d.inputTokens,
    outputTokens: acc.outputTokens + d.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
    totalTokens: acc.totalTokens + d.totalTokens,
    totalCost: acc.totalCost + d.totalCost,
  }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 });

  return { daily, totals, hasData: daily.length > 0 };
}

module.exports = { collectMinimaxUsage };
