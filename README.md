中文 · [English](README.en.md)

# oil

oiloil 的命令行工具，用来安装、更新和管理 oiloil 的 Skill。

需要 Node.js 18 以上，不用单独安装，直接用 npx 运行：

```bash
npx github:oil-oil/oil-cli install <skill>   # 安装
npx github:oil-oil/oil-cli update            # 更新本机装过的 Skill
npx github:oil-oil/oil-cli status            # 查看版本和账号
npx github:oil-oil/oil-cli help              # 全部命令
```

输出语言跟随系统，也可以用 `--lang zh` 或 `--lang en` 指定。Codex 的安装位置跟随 `CODEX_HOME`。

支持 Claude、Codex、agents、Cursor 和 WorkBuddy；省略 `--to` 会检测已有的用户目录，也可用 `--to workbuddy` 安装到 `~/.workbuddy/skills`。WorkBuddy 目前只支持用户目录：官方[项目配置说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project)列出的是 `.codebuddy/skills`，未确认项目级 `.workbuddy/skills`，因此不自动扫描或清理它；显式指定的路径按自定义目录处理。

安装或更新 Oil UI Pro 会自动移除同一 Agent 用户目录和当前项目里的开源版，无需确认；自定义目录只清理同目录，开发目录、符号链接和无法识别的同名目录会跳过。

支持 Windows、macOS 和 Linux。Windows 主目录优先使用 `USERPROFILE`，再用 `HOME`；配置保存在 `%APPDATA%\oil\config.json`，权限继承目录 ACL（POSIX 使用 `0600`）。解压使用系统 `tar.exe`，目录连接点（junction）与符号链接同样受清理保护。

Windows 输出的带路径命令按 PowerShell 引用。其他程序启动 CLI 时，应通过 `cmd.exe` 调用 `npx.cmd`，或用 Node 直接运行 npm 的 `bin/npx-cli.js`；Node 的 `execFile` 不能直接运行 `.cmd` 文件。

## 许可

[MIT](LICENSE)
