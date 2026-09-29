'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const { collectZcodeUsage } = require('./lib/zcode');
const { collectMinimaxUsage } = require('./lib/minimax');

const PORT = Number(process.env.PORT) || 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CCUSAGE_CLI = path.join(__dirname, 'node_modules', 'ccusage', 'src', 'cli.js');
const ECHARTS_DIST = path.join(__dirname, 'node_modules', 'echarts', 'dist', 'echarts.min.js');
// 离线模式用缓存价格表，亚秒级返回；在线模式每次联网拉最新价格，可能需要数十秒
const FAST_TIMEOUT_MS = 15_000;
const ONLINE_TIMEOUT_MS = 90_000;

/* Hermes 桌面端在 Windows 上的数据目录是 %LOCALAPPDATA%\hermes（其源码常量），
   而 ccusage 找不到 HERMES_HOME 时回退到 ~/.hermes（Linux/Mac 默认），会读空。
   检测到桌面端数据库存在时，给 ccusage 进程注入 HERMES_HOME 指向真实目录。 */
const HERMES_DESKTOP_HOME = path.join(os.homedir(), 'AppData', 'Local', 'hermes');

function ccusageEnv() {
  if (process.env.HERMES_HOME) return process.env; // 用户已显式指定，尊重之
  if (fs.existsSync(path.join(HERMES_DESKTOP_HOME, 'state.db'))) {
    return { ...process.env, HERMES_HOME: HERMES_DESKTOP_HOME };
  }
  return process.env;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function fetchUsage(since, until, { offline, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [CCUSAGE_CLI, 'daily', '--since', since, '--until', until, '--json', '--by-agent'];
    if (offline) args.push('--offline');
    const child = spawn(process.execPath, args, { cwd: __dirname, windowsHide: true, env: ccusageEnv() });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(offline ? 'ccusage 离线模式执行超时' : 'ccusage 执行超时'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ccusage 退出码 ${code}`));
        return;
      }
      // ccusage 对价格表外的模型记 cost=0 并打 WARN（走 stderr），透传给前端提示费用偏低
      const warnings = [...new Set(
        [...stderr.matchAll(/Missing embedded pricing for (\S+)/g)].map((m) => m[1]),
      )];
      try {
        resolve({ report: JSON.parse(stdout), warnings });
      } catch {
        reject(new Error('ccusage 输出解析失败'));
      }
    });
  });
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 本地日历加减天数（避免 toISOString 的 UTC 偏移问题） */
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function handleUsageApi(req, res, query) {
  const since = query.get('since') || localToday();
  const until = query.get('until') || since;

  if (!isValidDate(since) || !isValidDate(until)) {
    sendJson(res, 400, { error: '日期格式无效，应为 YYYY-MM-DD' });
    return;
  }
  if (since > until) {
    sendJson(res, 400, { error: '开始日期不能晚于结束日期' });
    return;
  }

  const forceOnline = query.get('pricing') === 'online';

  // 折线趋势需要至少 3 天：筛选 <3 天时把抓取起点扩到 until-2，
  // 之后从同一份数据切出严格筛选范围（report）与趋势范围（trend）
  const filterDays = Math.round((new Date(`${until}T00:00:00`) - new Date(`${since}T00:00:00`)) / 86400000) + 1;
  const fetchSince = filterDays < 3 ? addDaysIso(until, -2) : since;

  try {
    const startedAt = Date.now();
    let ccReport = null;
    let pricing = 'cached';
    let ccError = null;
    let ccWarnings = [];

    if (forceOnline) {
      try {
        ({ report: ccReport, warnings: ccWarnings } = await fetchUsage(fetchSince, until, { offline: false, timeoutMs: ONLINE_TIMEOUT_MS }));
        pricing = 'online';
      } catch (err) {
        ccError = err.message;
      }
    } else {
      // 先用缓存价格表快速返回；失败再联网拉最新价格
      try {
        ({ report: ccReport, warnings: ccWarnings } = await fetchUsage(fetchSince, until, { offline: true, timeoutMs: FAST_TIMEOUT_MS }));
      } catch {
        try {
          ({ report: ccReport, warnings: ccWarnings } = await fetchUsage(fetchSince, until, { offline: false, timeoutMs: ONLINE_TIMEOUT_MS }));
          pricing = 'online';
        } catch (err) {
          ccError = err.message;
        }
      }
    }

    // ZCode 与 MiniMax Code 不被 ccusage 支持，直接解析各自本地记录
    const zcode = collectZcodeUsage(fetchSince, until);
    const minimax = collectMinimaxUsage(fetchSince, until);
    const merged = mergeReports(
      ccReport ? stripCustomAgentRows(ccReport) : null,
      [zcode, minimax],
    );

    // 切分：trend = 扩展范围全部天；report = 严格筛选范围（重算 totals）
    const trendDaily = merged.daily;
    const trendTotals = sumDays(trendDaily);
    const strictDaily = trendDaily.filter((d) => d.period >= since && d.period <= until);
    const report = { daily: strictDaily, totals: sumDays(strictDaily) };

    sendJson(res, 200, {
      since,
      until,
      durationMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
      pricing,
      sources: {
        ccusage: Boolean(ccReport),
        zcode: zcode.hasData,
        minimax: minimax.hasData,
        ccusageError: ccError,
        warnings: ccWarnings,
      },
      report,
      trend: { since: fetchSince, until, daily: trendDaily, totals: trendTotals },
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message || '获取用量数据失败' });
  }
}

/* 按天行求和（五项 token + 费用） */
function sumDays(daily) {
  return (daily || []).reduce((acc, d) => ({
    inputTokens: acc.inputTokens + d.inputTokens,
    outputTokens: acc.outputTokens + d.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
    totalTokens: acc.totalTokens + d.totalTokens,
    totalCost: acc.totalCost + d.totalCost,
  }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 });
}

/* 防御性剔除 ccusage 数据里由本项目自解析的 agent 行，避免 ccusage 原生支持后双计。
   ccusage 的 day 级总量与顶层 modelBreakdowns 含被剔除 agent 的份额，
   因此全部从保留的 agents 行重建，不再信任其 day 级数字。 */
const CUSTOM_AGENTS = ['zcode', 'minimax'];

const DAY_TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'totalCost'];

function stripCustomAgentRows(report) {
  const keptDays = [];
  for (const day of report.daily || []) {
    if (!Array.isArray(day.agents) || !day.agents.length) {
      keptDays.push(day); // 无 per-agent 数据时无法安全剥离，保持原样
      continue;
    }
    const kept = day.agents.filter((a) => !CUSTOM_AGENTS.includes(a.agent));
    if (!kept.length) continue; // 整天只有自解析 agent：丢弃该天行

    const totals = Object.fromEntries(DAY_TOKEN_KEYS.map((k) => [k, 0]));
    const byModel = new Map();
    for (const a of kept) {
      for (const k of DAY_TOKEN_KEYS) totals[k] += a[k] || 0;
      for (const mb of a.modelBreakdowns || []) {
        let m = byModel.get(mb.modelName);
        if (!m) {
          m = { modelName: mb.modelName, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 };
          byModel.set(mb.modelName, m);
        }
        m.inputTokens += mb.inputTokens || 0;
        m.outputTokens += mb.outputTokens || 0;
        m.cacheCreationTokens += mb.cacheCreationTokens || 0;
        m.cacheReadTokens += mb.cacheReadTokens || 0;
        m.cost += mb.cost || 0;
      }
    }

    for (const k of DAY_TOKEN_KEYS) day[k] = totals[k];
    day.agents = kept;
    day.modelBreakdowns = [...byModel.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
    day.modelsUsed = day.modelBreakdowns.map((m) => m.modelName);
    day.metadata.agents = kept.map((a) => a.agent);
    keptDays.push(day);
  }
  report.daily = keptDays;
  return report;
}

/* ccusage 与自解析数据（zcode/minimax）按天合并：数值求和、breakdowns/agents 拼接 */
function mergeReports(ccReport, customReports) {
  const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens'];
  const byDay = new Map();

  const ensureDay = (period) => {
    let day = byDay.get(period);
    if (!day) {
      day = {
        period,
        agent: 'all',
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
        totalTokens: 0, totalCost: 0,
        modelsUsed: [],
        modelBreakdowns: [],
        metadata: { agents: [] },
        agents: [],
      };
      byDay.set(period, day);
    }
    return day;
  };

  const addTokens = (day, src) => {
    for (const k of TOKEN_KEYS) day[k] += src[k] || 0;
    day.totalCost += src.totalCost || 0;
  };
  const unionInto = (list, values) => {
    for (const v of values) if (!list.includes(v)) list.push(v);
  };

  for (const day of ccReport?.daily || []) {
    const row = ensureDay(day.period);
    addTokens(row, day);
    unionInto(row.modelsUsed, day.modelsUsed || []);
    row.modelBreakdowns.push(...(day.modelBreakdowns || []));
    unionInto(row.metadata.agents, day.metadata?.agents || []);
    row.agents.push(...(day.agents || []));
  }

  for (const custom of customReports) {
    for (const day of custom.daily || []) {
      const row = ensureDay(day.period);
      addTokens(row, day);
      unionInto(row.modelsUsed, day.modelsUsed || []);
      row.modelBreakdowns.push(...(day.modelBreakdowns || []));
      unionInto(row.metadata.agents, day.metadata?.agents || []);
      row.agents.push(...(day.agents || []));
    }
  }

  const daily = [...byDay.values()].sort((a, b) => a.period.localeCompare(b.period));
  const totals = daily.reduce((acc, d) => ({
    inputTokens: acc.inputTokens + d.inputTokens,
    outputTokens: acc.outputTokens + d.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
    totalTokens: acc.totalTokens + d.totalTokens,
    totalCost: acc.totalCost + d.totalCost,
  }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 });

  return { daily, totals };
}

async function serveFile(res, filePath, fallbackType) {
  try {
    const content = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || fallbackType || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && pathname === '/api/usage') {
    await handleUsageApi(req, res, url.searchParams);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    await serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  if (pathname === '/vendor/echarts.js') {
    await serveFile(res, ECHARTS_DIST, 'text/javascript; charset=utf-8');
    return;
  }

  // 静态文件：限制在 public 目录内，防止路径穿越
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (resolved.startsWith(PUBLIC_DIR + path.sep) || resolved === PUBLIC_DIR) {
    await serveFile(res, resolved);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`ccusage 看板已启动: http://localhost:${PORT}`);
});
