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

支持 Claude Code、Codex、Cursor、WorkBuddy 等 Agent，会自动找到它们的 Skill 目录，也可以用 `--to` 指定。本机只保留一份：优先放在 Claude Code 的目录，其余 Agent 用链接共享，更新一次全部生效；`~/.agents/skills` 只在 `--to agents` 时使用。输出语言跟随系统，也可以用 `--lang zh` 或 `--lang en` 指定。支持 macOS、Linux 和 Windows。

## 许可

[MIT](LICENSE)
