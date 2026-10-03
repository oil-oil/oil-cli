# oil

oiloil 商店的命令行工具。用它安装和更新 Oil UI 这类 Skill：付费 Skill 在浏览器里登录、付款，装好以后会跟着新版本自动更新。

## 安装 Skill

把这句话发给你的 Agent：

```text
帮我安装 Oil UI Pro：运行 npx github:oil-oil/oil-cli install oil-ui-pro
```

也可以自己在终端运行这行命令。需要 Node.js 18 以上，oil 本身不用单独安装。

安装付费 Skill 会经过三步，都在浏览器里完成：

1. 打开授权页，登录 oiloil 账号，核对授权码后点“允许”；
2. 还没购买时自动打开付款页，支持微信、支付宝和银行卡；
3. 付款完成后，oil 自动下载并安装。

Skill 会装进本机检测到的 Agent 目录：`~/.claude/skills`、`~/.codex/skills`、`~/.cursor/skills`，以及已经存在的 `~/.agents/skills`。如果 Agent 中途停下来，提示你去浏览器登录或付款，完成后让它再运行一次同样的命令就能接着装。

## 更新

Skill 自带版本检查，每天最多联网一次，有新版本就自动更新：在 Claude Code 里加载 Skill 时自动进行，在其他 Agent 里由 Agent 开始任务前运行。付费 Skill 的更新需要这台电脑登录过购买时用的账号。

也可以随时手动更新，或者看看本机装的是哪一版：

```bash
npx github:oil-oil/oil-cli update
npx github:oil-oil/oil-cli status
```

## 常用命令

下面的 `oil` 都可以换成 `npx github:oil-oil/oil-cli`。

| 命令 | 作用 |
| --- | --- |
| `oil install <skill>` | 安装。想指定位置时加 `--to`，可以写 `claude`、`codex`、`agents`、`cursor` 或一个 skills 目录 |
| `oil update` | 把本机的 Skill 都更新到最新版 |
| `oil status` | 看账号、购买情况和本机每个 Skill 的版本；有新版本时列出中间每一版的更新说明 |
| `oil list` | 看商店里能装的 Skill 和价格 |
| `oil subscribe <skill>` | 购买，买好后自动安装 |
| `oil manage` | 打开账单和付款方式的管理页 |
| `oil login`、`oil logout` | 登录或退出这台电脑 |

## 在服务器和 CI 上用

没有浏览器的环境，在 [ui.oiloil.org/account](https://ui.oiloil.org/account/) 新建一个令牌，再用 `oil login --token <令牌>` 保存，或者设置环境变量 `OIL_TOKEN`。环境变量 `CI` 为真时，oil 不会打开浏览器登录或付款页，需要登录或购买时直接退出。

所有命令都支持 `--json`。退出码：0 成功，1 出错，2 用法错误，3 需要登录或购买。

## 安全

- 令牌存在 `~/.config/oil/config.json`（Windows 是 `%APPDATA%\oil\config.json`），文件权限 600，输出里只显示前 8 个字符。
- 令牌只发给签发它的服务器。用环境变量 `OIL_API` 换了接口地址时，保存的令牌不会被发过去；接口地址必须是 HTTPS，只有本机调试地址可以用 HTTP。
- 安装前校验 SHA256、压缩包结构和 SKILL.md 的名称与版本，全部通过才整体替换，失败时还原原目录。
- 含 `.git` 的目录是开发目录，oil 不会替换或删除它；软链接会先解析再判断。
- 授权过的电脑都列在 [ui.oiloil.org/account](https://ui.oiloil.org/account/)，可以随时撤销。

## 许可

[MIT](LICENSE)
