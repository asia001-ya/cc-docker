# Claude 内置定价

核对日期：2026-10-18。单位：USD / 百万 token。来源：[Anthropic 官方定价](https://platform.claude.com/docs/en/about-claude/pricing)、[模型 ID 与生命周期](https://platform.claude.com/docs/en/about-claude/model-deprecations)。

该目录包含当前官方价目表中的 20 个模型，以及 6 个常用历史快照/预览模型的兼容价格；退役模型仍可在部分中转供应商中使用。价格只是本工具的成本估算基准，不代表各中转供应商的实际账单。

| 模型（或快照） | 输入 | 输出 | 缓存读取 | 缓存写入（5 分钟） |
|---|---:|---:|---:|---:|
| Claude Opus 5.5 | 4 | 20 | 0.2 | 5 |
| Claude Sonnet 5.5 | 2 | 10 | 0.1 | 2.5 |
| Claude Haiku 5.5 | 0.1 | 0.5 | 0.01 | 0.125 |
| Claude Fable 5.1 | 10 | 50 | 0.25 | 12.5 |
| Claude Mythos 5.1 | 10 | 50 | 0.25 | 12.5 |
| Claude Fable 5 | 10 | 50 | 1 | 12.5 |
| Claude Mythos 5 | 10 | 50 | 1 | 12.5 |
| Claude Opus 5 | 5 | 25 | 0.5 | 6.25 |
| Claude Opus 4.8 | 5 | 25 | 0.5 | 6.25 |
| Claude Opus 4.7 | 5 | 25 | 0.5 | 6.25 |
| Claude Opus 4.6 | 5 | 25 | 0.5 | 6.25 |
| Claude Opus 4.5 | 5 | 25 | 0.5 | 6.25 |
| Claude Opus 4.1 | 15 | 75 | 1.5 | 18.75 |
| Claude Opus 4 | 15 | 75 | 1.5 | 18.75 |
| Claude Sonnet 5 | 2 | 10 | 0.2 | 2.5 |
| Claude Sonnet 4.6 | 3 | 15 | 0.3 | 3.75 |
| Claude Sonnet 4.5 | 3 | 15 | 0.3 | 3.75 |
| Claude Sonnet 4 | 3 | 15 | 0.3 | 3.75 |
| Claude Haiku 4.5 | 1 | 5 | 0.1 | 1.25 |
| Claude Haiku 3.5 | 0.8 | 4 | 0.08 | 1 |
| Claude Sonnet 3.7 | 3 | 15 | 0.3 | 3.75 |
| Claude Sonnet 3.5 (2024-10) | 3 | 15 | 0.3 | 3.75 |
| Claude Sonnet 3.5 (2024-06) | 3 | 15 | 0.3 | 3.75 |
| Claude Haiku 3 | 0.25 | 1.25 | 0.025 | 0.3125 |
| Claude Opus 3 | 15 | 75 | 1.5 | 18.75 |
| Claude Mythos Preview | 25 | 125 | 2.5 | 31.25 |

Haiku 5.5：单个请求的普通输入 + 缓存读取 + 缓存写入 **超过 100,000 token** 时，整次请求改用输入 0.5、输出 2.5、缓存读取 0.05、缓存写入 0.625；恰好 100,000 仍用基价。只有该模型四项单价仍等于官方基价时自动使用此阶梯，修改为自定义报价后按填写的固定单价计算。

## 安装、补齐与计价

- 共享目录为 `src/data/claude-pricing.json`：前端直接导入，Rust 用 `include_str!` 编译进可执行文件。安装后离线可用，无须复制开发机器上的配置目录。
- 应用加载时为每个已有供应商补齐缺失的模型条目，并原子写入 `providers.json`；新建或保存供应商时同样补齐。已有报价（包括四项显式 0）、默认回退价和容器绑定保留。
- 设置 → API 供应商 → 编辑 → 用量定价可展开模型修改费率，或恢复该模型的官方价。内置模型条目不能删除；要按免费计算，请将四项单价设为 0。额外模型仍可新增、删除。
- 已收录别名随 canonical 模型价格展开到启动时快照；单独填写的精确别名报价优先。未收录的模型使用供应商默认回退价，不对未知型号猜测费率。
- 改价后需重新应用供应商或重启容器，再新启动 Claude。计价快照包含别名和阶梯，无须容器联网查询价目。正在运行的 Claude 和已保存的历史请求保持原价格；不会对旧的零成本记录追溯计价。
- 同一请求后续补全输入或缓存计数跨过阈值时，按首次记录中冻结的阶梯规则重新选档；后续供应商调价不能替换该规则。旧记录未保存阶梯规则时继续使用原固定价格。
- 升级时仅补缺项；不会覆盖已有报价。若同一模型官方价格更新，可在设置中恢复新版内置官方价。供应商连接信息、Token 和自定义报价仍属于个人配置，需另行迁移。

## 估算范围

当前采集字段仅记录普通输入、输出、缓存读取、合计缓存写入，因此缓存写入按 5 分钟价估算。1 小时缓存写入通常为基础输入价的 2 倍，但当前不会单独识别。Batch 半价、Fast 加价、地区费率、平台差价、工具调用费及税费不自动计算，可按供应商实际报价调整固定单价。

当前 Fast 基础输入/输出价：Opus 5.5 为 8/40，Opus 5 和 4.8 为 10/50。US inference 使用 1.1 倍，缓存倍率继续叠加。当前 4.6 及之后的模型（Haiku 5.5 除外）在 1M 上下文内不额外涨价；Sonnet 4/4.5 的旧 1M beta 已结束，未加入历史长上下文涨价。

## 分发包与个人数据隔离

安装包只携带公开模型定价、程序及公共资源。真实供应商名称、地址、Token，授权账号与登录凭据，以及代理节点、订阅链接、用户名、密码、密钥、绑定关系均不得写入源码默认值、公开价目、静态资源或打包资源清单。会话与用量记录也不随安装包分发。

供应商与代理配置由运行时从当前用户的应用配置目录加载，密钥使用当前用户的 Windows 凭据管理器；Claude 授权数据保存在对应容器的数据卷。新电脑安装后，供应商、账号和代理列表均为空，由用户自行添加或授权，再自动获得内置模型价格。已有电脑的个人配置不因这次隔离处理被删除或清空。

演示供应商、账号、代理、会话和用量仅在开发模式生成，正式构建会裁掉。`npm run build` 在生成前后运行公共资源检查，Rust 构建也调用同一检查：公开价目字段、额外资源清单、私有配置文件和生产演示数据不符合规则时直接失败。手工 Docker 构建通过 `.dockerignore` 的公共文件允许列表限制上下文。此检查用于阻止常见误打包，发布前仍应审核新增资源与代码；不要将整个工作目录、AppData 或 Docker 用户数据卷一起分发。

## 历史来源

- [Sonnet 3.7](https://www.anthropic.com/news/claude-3-7-sonnet)、[Sonnet 3.5](https://www.anthropic.com/news/claude-3-5-sonnet)、[Claude 3 系列](https://www.anthropic.com/news/claude-3-family)、[Mythos Preview](https://www.anthropic.com/glasswing)：官方输入/输出价格。
- [Prompt caching 公告](https://www.anthropic.com/news/prompt-caching)：Sonnet 3.5 与 Opus 3 缓存价格直接列示。
- Haiku 3、Sonnet 3.7、Mythos Preview 的精确缓存价格采用官方基础输入价 × 1.25（5 分钟写入）/ × 0.1（读取）。Haiku 3 保留 0.3125 / 0.025 的精度，避免新闻稿两位小数舍入。
- [官方 SDK 旧型号及别名](https://github.com/anthropics/anthropic-sdk-python/blob/v0.69.0/src/anthropic/types/model.py)、[当前 SDK 型号](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/model.py)。
