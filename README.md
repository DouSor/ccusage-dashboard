# CCUsage Dashboard · Token 用量看板

本地运行的 coding agent token 用量看板，基于 [ccusage](https://github.com/ryoppippi/ccusage) 解析 Claude Code / Codex 等 agent 在本机留下的会话记录（JSONL），并内置 ZCode 会话记录解析，纯本地计算，数据不出机器。

支持的数据源：

- **Claude Code / Codex / OpenCode / Hermes**：经由 ccusage 读取各自本机记录。Hermes 桌面端在 Windows 上的数据目录是 `%LOCALAPPDATA%\hermes`（非 ccusage 默认的 `~/.hermes`），看板检测到该目录后会自动以进程级 `HERMES_HOME` 环境变量告知 ccusage，无需手动配置
- **ZCode**：直接解析 `~/.zcode/cli/rollout/model-io-sess_*.jsonl`（每行一次模型调用，按本地时区归天，含子代理会话）；ZCode 的 inputTokens 已含缓存读/写，展示时自动拆分为 净输入 / 缓存写 / 缓存读 四分量。新版 ccusage 也内置了 zcode 适配器，看板会自动去重、以自解析数据为准（时区口径一致且支持 prices.json 计价）
- **MiniMax Code**：直接解析 `~/.minimax/v2/sessions/**/messages.jsonl` 的 assistant 行（分列口径与 ccusage 一致，无需换算）；注意 ccusage 输出里的 "Hermes" 是另一个独立产品，与 MiniMax Code 无关

ccusage 的新模型价格来自其内置价格表（随版本更新），因此看板会在每次启动时自动更新 ccusage；若仍有模型缺价，页面顶部会出现警告条（费用偏低），ZCode 模型的价格可通过下方 `prices.json` 补充。

- **ZCode 成本估算（可选）**：在项目根目录创建 `prices.json`（单位：USD / 百万 token）：
  ```json
  { "GLM-5.3-Flash": { "input": 0.1, "output": 0.4, "cacheRead": 0.02, "cacheWrite": 0.2 } }
  ```
  未配置的模型成本计为 0。

## 功能

- **默认显示当天**用量，打开即见
- **日期快捷预设**：今天 / 昨天 / 近 7 天 / 近 30 天 / 本月
- **自定义日期范围**：双月日历弹层（上月 + 本月，可翻页），第一次点击选开始日期、第二次点击选结束日期并自动确认
- **手动刷新**：点「刷新」重新读取最新本地记录
- **汇总卡片**：总 Token、费用估算（USD）、Input / Output / Cache 写入 / Cache 读取
- **趋势折线 + 模型分布饼图**：折线图按天展示 Token 总量（筛选不足 3 天时自动扩为以最晚一天结尾的 3 天）；右侧饼图严格按筛选范围聚合各模型用量占比（悬停看明细，中心为范围总量）
- **设置**（顶栏「设置」按钮弹出对话框，选择保存在浏览器本地）：
  - 外观：白天 / 夜间（默认）/ 跟随系统（实时跟随操作系统明暗偏好）
  - Token 单位：M/B（默认，如 15.91M）/ 百万·十亿（15.91百万）/ 万·亿（1590.5万）
- **近 180 天热力图**：GitHub 贡献图风格的日历视图，固定显示今天往前 180 天（不受时间筛选影响），冰蓝色阶表示当日用量，悬停看日期 + 总量 + 费用；仅初始加载和点「刷新」时更新
- **明细表格**：按 Agent × 模型 聚合展示选定范围内的总用量（不分天），含合计行

## 快速开始

**方式一（推荐）：双击项目根目录的 `启动看板.vbs`**

- 每次启动服务前自动把 ccusage 更新到最新版（新模型的内置价格表随新版本更新），更新日志在 `logs/ccusage-update.log`；更新失败（如断网）不影响启动
- 自动在后台启动服务（无控制台窗口），等服务就绪后用默认浏览器打开看板
- 如果服务已在运行则不会重复启动、也不重复更新，直接打开页面
- 双击 `停止看板.vbs` 可停止后台服务（只停本项目，不影响其他 node 程序）

**方式二：命令行**

```bash
npm install   # 首次使用
npm start
```

打开 http://localhost:3456 即可（端口可用 `PORT=xxxx npm start` 修改）。

> 提示：把 `启动看板.vbs` 的快捷方式放进 `shell:startup` 文件夹（Win+R 输入）可实现开机自动启动。
> 启动器支持 `/no-browser` 参数：只启动服务、不打开浏览器（`cscript //nologo 启动看板.vbs /no-browser`）。

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
