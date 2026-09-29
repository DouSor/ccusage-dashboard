'use strict';

/**
 * 解析 ZCode 本地会话的模型调用记录，产出与 ccusage `daily --json --by-agent`
 * 同构的用量数据，供 /api/usage 合并。
 *
 * 数据源：~/.zcode/cli/rollout/model-io-sess_*.jsonl（每行 = 一次模型 API 调用）。
 * 行内 response.usage.inputTokens 已包含缓存读/写，为与 ccusage 口径一致
 * （input 不含缓存、四分量相加 = 总量），此处做拆分：
 *   净输入 = inputTokens - cacheReadTokens - cacheWriteTokens
 *   总量   = inputTokens + outputTokens
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPrices, modelCost } = require('./prices');

const ZCODE_AGENT = 'zcode';
const ROLLOUT_DIR = path.join(os.homedir(), '.zcode', 'cli', 'rollout');

const ZERO_MODEL_BREAKDOWN = () => ({
  modelName: '',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  cost: 0,
});

function pad2(n) { return String(n).padStart(2, '0'); }

/* completedAt（UTC ISO）→ 本地日期 YYYY-MM-DD，与 ccusage 的按天口径一致 */
function isoToLocalDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* 单行记录 → 口径拆分后的分量；无效行返回 null */
function parseLine(line) {
  if (!line.trim()) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // 文件实时写入中，容忍半行
  }
  const usage = entry?.response?.usage;
  const date = isoToLocalDate(entry?.completedAt);
  if (!usage || !date) return null;

  const cacheRead = usage.cacheReadTokens || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const inputTotal = usage.inputTokens || 0;
  const netInput = Math.max(0, inputTotal - cacheRead - cacheWrite);
  const output = usage.outputTokens || 0;

  return {
    date,
    model: entry?.model?.modelId || 'unknown',
    inputTokens: netInput,
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    totalTokens: inputTotal + output,
  };
}

function collectZcodeUsage(since, until) {
  const prices = loadPrices();
  // per-day: { tokens, models: Map(modelName -> breakdown) }
  const days = new Map();

  let files = [];
  try {
    files = fs.readdirSync(ROLLOUT_DIR)
      .filter((f) => f.startsWith('model-io-sess_') && f.endsWith('.jsonl'));
  } catch {
    // 未安装 ZCode 或目录不存在：返回空数据而非报错
  }

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(ROLLOUT_DIR, file), 'utf8');
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
        mb = ZERO_MODEL_BREAKDOWN();
        mb.modelName = rec.model;
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

  // 组装为 ccusage daily 行的同构结构
  const daily = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, day]) => {
      const modelBreakdowns = [...day.models.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
      const dayCost = modelBreakdowns.reduce((s, m) => s + m.cost, 0);
      const agentEntry = {
        agent: ZCODE_AGENT,
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
        metadata: { agents: [ZCODE_AGENT] },
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

module.exports = { collectZcodeUsage };
