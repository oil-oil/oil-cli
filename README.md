# oil

oiloil 商店的命令行工具：安装和更新 Oil UI 这类 Skill，付费版用浏览器登录授权。

## 安装 Skill

把这句话发给你的 Agent：

```text
帮我安装 Oil UI Pro：运行 npx github:oil-oil/oil-cli install oil-ui-pro
```

也可以自己在终端运行这行命令。需要 Node.js 18 以上，oil 本身不用单独安装。

oil 会把 Skill 装进本机检测到的 Agent 目录：`~/.claude/skills`、`~/.codex/skills`、`~/.cursor/skills`，以及已经存在的 `~/.agents/skills`。付费 Skill 第一次安装时会打开浏览器，登录订阅用的 oiloil 账号，核对终端里显示的代码后点“允许”，安装会自动继续。

## 常用命令

下面的 `oil` 都可以换成 `npx github:oil-oil/oil-cli`。

| 命令 | 作用 |
| --- | --- |
| `oil status` | 看账号、订阅和本机每个 Skill 的版本；有新版本时列出中间每一版的更新说明 |
| `oil update` | 把本机的 Skill 都更新到最新版 |
| `oil install <skill>` | 安装。想指定位置时加 `--to`，可以写 `claude`、`codex`、`agents`、`cursor` 或一个 skills 目录 |
| `oil list` | 看商店里能装的 Skill 和价格 |
| `oil subscribe <skill>` | 打开付款页，订阅生效后自动安装 |
| `oil manage` | 打开订阅管理页：换卡、看账单、取消订阅 |
| `oil login`、`oil logout` | 登录或退出这台设备 |

## 在服务器和 CI 上用

没有浏览器时，在 [ui.oiloil.org/account](https://ui.oiloil.org/account/) 新建一个令牌，用 `oil login --token <令牌>` 保存，或者设置环境变量 `OIL_TOKEN`。环境变量 `CI` 为真时，oil 不会发起浏览器登录。

所有命令都支持 `--json`。退出码：0 成功，1 出错，2 用法错误，3 没登录或没有订阅。

## 安全

- 安装前校验 SHA256、压缩包结构和 SKILL.md 的名称与版本，全部通过才整体替换，失败时还原原目录。
- 含 `.git` 的目录是开发目录，oil 不会替换或删除它；软链接会先解析再判断。
- 令牌存在 `~/.config/oil/config.json`（Windows 是 `%APPDATA%\oil\config.json`），文件权限 600，输出里只显示前 8 个字符。
- 同一个位置先装了免费版、再装付费版时，免费版会被移除，两个版本同时装会抢着接同一类请求。

## 许可

[MIT](LICENSE)
