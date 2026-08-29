# CCUsage Dashboard · Token 用量看板

本地运行的 coding agent token 用量看板，基于 [ccusage](https://github.com/ryoppippi/ccusage) 解析 Claude Code / Codex 等 agent 在本机留下的会话记录（JSONL），纯本地计算，数据不出机器。

## 功能

- **默认显示当天**用量，打开即见
- **日期快捷预设**：今天 / 昨天 / 近 7 天 / 近 30 天 / 本月
- **自定义日期范围**：起止日期选择器
- **手动刷新**：点「刷新」重新读取最新本地记录
- **汇总卡片**：总 Token、费用估算（USD）、Input / Output / Cache 写入 / Cache 读取
- **趋势图表**（ECharts）：
  - 多日范围 → 按日堆叠柱状图，可切换「绝对值 / 占比 %」，tooltip 含当日费用
  - 单日 → 按模型分布柱状图
- **设置**（顶栏「设置」按钮，选择保存在浏览器本地）：
  - 外观：夜间（默认）/ 白天
  - Token 单位：M/B（默认，如 15.91M）/ 百万·十亿（15.91百万）/ 万·亿（1590.5万）
- **近 180 天热力图**：GitHub 贡献图风格的日历视图，固定显示今天往前 180 天（不受时间筛选影响），冰蓝色阶表示当日用量，悬停看日期 + 总量 + 费用；仅初始加载和点「刷新」时更新
- **明细表格**：按 Agent × 模型 聚合展示选定范围内的总用量（不分天），含合计行

## 快速开始

```bash
npm install
npm start
```

打开 http://localhost:3456 即可（端口可用 `PORT=xxxx npm start` 修改）。

## 工作原理

```
浏览器 ──GET /api/usage?since=&until=──▶ server.js (Node 内置 http)
                                            │
                                            ▼ spawn
                                     本地 ccusage CLI
                              (读取 ~/.claude 等本机会话记录)
```

- 后端调用本地安装的 ccusage CLI（`daily --json --by-agent`）获取结构化数据，前端原生 JS + ECharts 渲染，**零构建**。
- **价格数据默认走本地缓存**（`--offline`），接口响应在 1 秒内；如需联网拉取最新价格表，请求 `GET /api/usage?...&pricing=online`（较慢，数十秒）。
- 费用为按模型价格表的估算值，仅供参考。

## 依赖

- Node.js ≥ 18
- `ccusage`（npm 依赖，随项目安装）
- `echarts`（npm 依赖，本地文件直接引入，离线可用）
