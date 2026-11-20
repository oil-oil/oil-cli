# AGENTS.md

`oil-cli` 是公开的 oiloil 商店 Skill 安装器 CLI（Node.js 18+ ESM，零第三方运行时依赖）。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| [`bin/oil.js`](bin/oil.js) | CLI 可执行入口，向 `src/cli.js` 的 `run()` 传入命令行参数并设置退出码 |
| [`src/cli.js`](src/cli.js) | 参数解析、`status`/`list`/`install`/`update`/`subscribe`/`manage`/`login`/`logout` 命令编排、主 Skill 与附属 Skill（`included`）安装更新及开源版替代编排 |
| [`src/client.js`](src/client.js) | 商店 API 客户端、商品目录与版本结构校验、`OIL_API` HTTPS/本机地址校验、下载 302 跳转逐跳校验、`OIL_DOWNLOAD_TIMEOUT` 超时控制及 401/402 错误映射 |
| [`src/skills.js`](src/skills.js) | `SKILL.md` frontmatter 解析、各 Agent 用户级/项目级目录发现、软链接与 `.git` 开发目录识别、单机主安装与跨 Agent 链接共享、开源版清理候选与多副本检测 |
| [`src/install.js`](src/install.js) | 安装包流式下载、SHA256 与版本头校验、`tar.gz` 解压前流式安全预检（拒绝路径穿越、硬/软链接、Windows 非法文件名与大小写碰撞）、多目标暂存与整批事务替换/回滚 |
| [`src/auth.js`](src/auth.js) | 设备码授权轮询、跨轮次待领取设备码恢复、`--token`/`OIL_TOKEN` 登录与 `CI` 环境约束 |
| [`src/purchase.js`](src/purchase.js) | 付费购买会话创建、轮询解锁、跨轮次未完成会话恢复及商店购买前提醒（`notice`）透传 |
| [`src/config.js`](src/config.js) | `config.json` 原子读写、权限保护（POSIX `0600` / Windows 继承 `APPDATA` ACL）及按 API origin 与 token hash 隔离凭据和待恢复记录 |
| [`src/i18n.js`](src/i18n.js) | 中英双语词典、语言优先级（`--lang` > `OIL_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG`，默认中文）与可复制命令引用转义 |
| [`src/io.js`](src/io.js) | 标准输出与 `--json`（含 JSON Lines）格式化、全链路令牌与设备密钥脱敏、终端交互确认 |
| [`src/platform.js`](src/platform.js) | POSIX / Windows 路径规范化（含 8.3 短路径与大小写归一）、权限设置与系统 `tar` 调用参数 |
| [`src/browser.js`](src/browser.js) | 跨平台打开系统默认浏览器（macOS `open`、Windows `cmd.exe start`、Linux `xdg-open`） |
| [`scripts/test.js`](scripts/test.js) | `npm test` 调用的全量测试入口，枚举 `test/*.test.js` 交由 `node --test` 执行（兼容 Windows `cmd.exe` 与 Node 18） |
| `test/` | 自动化测试与夹具：`fixture.js` 提供临时目录、本机假服务与模拟浏览器，`driver.js` 注入虚拟时钟与交互回答，`*.test.js` 为回归测试，`manual.js` 为真实入口双语冒烟脚本 |

## 发布方式与跨仓库配对发版

- **合并 `main` 即生效**：所有 `npx github:oil-oil/oil-cli` 用户默认直接拉取本仓库 `main` 分支运行。改动必须走独立分支与 PR 验证，严禁将未审改动直接推送到 `main`。
- **版本号与提交信息**：版本号维护在 [`package.json`](package.json) 的 `version` 字段；发版或变更对外行为时必须同步更新 `package.json` 版本号，且提交信息需带上版本号（例如 `feat(cli): 支持付费 Skill 附赠的配套 Skill 安装与更新（0.4.0）`）。
- **谁固定了本仓库的提交**：以下仓库在代码中固定了本仓库的提交（commit SHA）：
  - `oil-ui-pro` 的 `scripts/check_update.py`
  - 公开 `oil-ui` 的 `scripts/check_update.py`（同文件）
  - `dsh-oil-ui` 的 `src/skill/install.ts`
- **跨仓库配对发版**：本仓库改动合并后需要同步更新上述仓库并配对发版，流程见唯一来源：[跨仓库配对发版](https://github.com/oil-oil/oil-ui-pro/blob/main/.github/RELEASING.md#跨仓库配对发版)。

## 兼容性红线

- **客户端与服务端双向兼容**：新 CLI 必须兼容旧服务端，旧 CLI 必须兼容新服务端（新增接口字段、目录可选字段或未发布附属版本时均需平稳处理，不因缺省或未知扩展字段崩溃）。
- **`--json` 输出只增不改**：`--json`（含登录与付款等待的 JSON Lines）只允许新增可选字段，禁止删除或重命名已有字段、改变字段类型或改动退出码语义（`0` 成功、`1` 运行错误、`2` 参数/用法错误、`3` 需登录或完成购买）。

## 附属 Skill（`included`）行为约定

- **共用主付费 Skill 授权**：商品目录中付费产品通过 `included` 声明附赠的附属（配套）Skill（如 `oil-ui-pro` 附赠 `oil-art-landing`）。附属 Skill 无独立购买方案，授权校验与购买会话均归属主付费 Skill（`entitlementSkill` 指向主付费 Skill）。
- **随主安装与更新补齐**：
  - `install <主付费Skill>`：在同一组目标目录一并安装主 Skill 与已发布版本的附属 Skill（首选目录放真实文件，其余目录建链接；交互确认前会列出将随附安装的附属 Skill）。
  - `update`：已装非开发目录的主付费 Skill 时，在同一作用域内自动补齐新发布、尚未安装的附属 Skill。用户级目录中若存在多份主 Skill 独立副本，按整组用户级目录去重，只规划一次附属 Skill；`update --path <目录>` 更新单份主付费 Skill 时，除在该目录所在根下补齐外，也会同时在链接到同一份主 Skill 的其他用户级 Agent 目录里建立附属 Skill 的链接。
- **独立批次与故障隔离**：每个附属 Skill 单独成批执行。服务端尚未发布该附属 Skill 版本时静默跳过；遇到未登录、授权失效（HTTP 402）、下载失败或目标同名目录被无法识别的文件占用时，只跳过该附属 Skill 并记入 `warnings` 或 `skipped`，**不回滚主付费 Skill，也不阻断其他 Skill 更新**；`update` 仅需补装附属 Skill 且本机未登录时，**不触发设备码登录**，只输出提示后跳过。
- **独立安装与开源版保护**：支持单独运行 `install <附属Skill>`（复用主付费 Skill 授权），但**只有主付费 Skill 能替代并清理同一 Agent 的免费开源版**；单独安装或更新附属 Skill 绝不删除开源版。
- **402 提示指向主付费 Skill**：已安装的附属 Skill 在更新或下载收到 HTTP 402 时，错误提示文案、JSON 的 `subscribe_command` 与 `subscription_url` 一律指向所属的主付费 Skill。

## 测试要求与常用命令

- **测试隔离红线**：所有测试必须通过 [`test/fixture.js`](test/fixture.js) 在系统临时目录中隔离 `HOME`、`USERPROFILE`、`XDG_CONFIG_HOME`、`APPDATA`、`CODEX_HOME`，并注入本机 `127.0.0.1` 假服务（`OIL_API`）与模拟浏览器脚本；**严禁读写用户真实目录，严禁发起真实外网请求或打开真实系统浏览器**。
- **全量测试**：`npm test`（执行 `node scripts/test.js` 跑完全部 `test/*.test.js`）。
- **单文件快测**：`node --test test/<file>.test.js`。
- **双语端到端冒烟**：`node test/manual.js`（真实 CLI 入口与时钟，仍使用本地假服务与临时 `HOME`）。

## 开发约定（oil-dev）

- 快测：`node --test {target}`
- 门禁：`npm test`
- 高风险：`bin/`、`src/`、`package.json`
