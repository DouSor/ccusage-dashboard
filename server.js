'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fsp = require('fs/promises');

const PORT = Number(process.env.PORT) || 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CCUSAGE_CLI = path.join(__dirname, 'node_modules', 'ccusage', 'src', 'cli.js');
const ECHARTS_DIST = path.join(__dirname, 'node_modules', 'echarts', 'dist', 'echarts.min.js');
// 离线模式用缓存价格表，亚秒级返回；在线模式每次联网拉最新价格，可能需要数十秒
const FAST_TIMEOUT_MS = 15_000;
const ONLINE_TIMEOUT_MS = 90_000;

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
    const child = spawn(process.execPath, args, { cwd: __dirname, windowsHide: true });

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
      try {
        resolve(JSON.parse(stdout));
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

  try {
    const startedAt = Date.now();
    let report;
    let pricing = 'cached';

    if (forceOnline) {
      report = await fetchUsage(since, until, { offline: false, timeoutMs: ONLINE_TIMEOUT_MS });
      pricing = 'online';
    } else {
      // 先用缓存价格表快速返回；失败再联网拉最新价格
      try {
        report = await fetchUsage(since, until, { offline: true, timeoutMs: FAST_TIMEOUT_MS });
      } catch {
        report = await fetchUsage(since, until, { offline: false, timeoutMs: ONLINE_TIMEOUT_MS });
        pricing = 'online';
      }
    }

    sendJson(res, 200, {
      since,
      until,
      durationMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
      pricing,
      report,
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message || '获取用量数据失败' });
  }
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
