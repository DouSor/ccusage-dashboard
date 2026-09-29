'use strict';

/**
 * 可选价格表 prices.json（项目根），供各数据源解析器估算成本：
 * { "模型ID": { "input": …, "output": …, "cacheRead": …, "cacheWrite": … } }
 * 单位均为 USD / 百万 token；未配置的模型成本计 0。
 */

const fs = require('fs');
const path = require('path');

const PRICES_FILE = path.join(__dirname, '..', 'prices.json');

let pricesCache = { mtime: -1, prices: {} };

function loadPrices() {
  try {
    const stat = fs.statSync(PRICES_FILE);
    if (stat.mtimeMs === pricesCache.mtime) return pricesCache.prices;
    const parsed = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
    const prices = {};
    for (const [model, p] of Object.entries(parsed || {})) {
      prices[model] = {
        input: Number(p.input) || 0,
        output: Number(p.output) || 0,
        cacheRead: Number(p.cacheRead) || 0,
        cacheWrite: Number(p.cacheWrite) || 0,
      };
    }
    pricesCache = { mtime: stat.mtimeMs, prices };
    return prices;
  } catch {
    pricesCache = { mtime: -1, prices: {} };
    return {};
  }
}

/* 按四分量（token 数）与单价（USD/百万 token）计算成本 */
function modelCost(prices, modelName, b) {
  const p = prices[modelName];
  if (!p) return 0;
  return (b.inputTokens * p.input
    + b.outputTokens * p.output
    + b.cacheReadTokens * p.cacheRead
    + b.cacheCreationTokens * p.cacheWrite) / 1e6;
}

module.exports = { loadPrices, modelCost };
