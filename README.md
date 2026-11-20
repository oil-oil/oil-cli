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

支持 Claude Code、Codex、DeepSeek Harness、Cursor、WorkBuddy 等 Agent，会自动找到它们的 Skill 目录，也可以用 `--to` 指定。本机只保留一份：优先放在 Claude Code 的目录，其余 Agent 用链接共享（Codex 与 DeepSeek Harness 等默认共用 `~/.agents/skills`，`--to codex` 与 `--to dsh` 分别使用 `~/.codex/skills` 与 `~/.dsh/skills`），更新一次全部生效。状态检查和更新也会扫描已有的用户级 `~/.dsh/skills` 和项目级 `.dsh/skills`；`update` 可指定 `<skill>` 或用 `--path <目录>` 只更新单个安装目录。付费 Skill 附赠的配套 Skill（例如 Oil UI Pro 附赠的 `oil-art-landing`）共用主付费 Skill 的授权：安装主 Skill 时会先在确认提示中列出随附的配套 Skill 并一起装到同样的位置，`update`（含 `update --path`，会同步覆盖链接到同一份主 Skill 的其他用户级目录）也会自动补齐尚未安装的配套 Skill；配套 Skill 也可单独 `install`，且只有安装或更新主付费 Skill 会自动移除同一 Agent 的开源版，单独安装配套 Skill 不会删除开源版。配套 Skill 暂时装不上（未登录、授权失效、下载失败或目录被占用）时只跳过它并给出提示（`update` 仅需补装配套 Skill 且未登录时不会弹出登录），不影响主 Skill 和其他更新；已安装的配套 Skill 更新遇到未购买或授权失效（402）时，提示的 `subscribe` 命令与购买链接均指向主付费 Skill。输出语言跟随系统，也可以用 `--lang zh` 或 `--lang en` 指定。支持 macOS、Linux 和 Windows。

## 许可

[MIT](LICENSE)
