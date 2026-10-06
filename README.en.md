[中文](README.md) · English

# oil

The oiloil CLI for installing, updating, and managing oiloil skills.

Requires Node.js 18 or later. Run it with npx; no separate install needed:

```bash
npx github:oil-oil/oil-cli install <skill>   # Install a skill
npx github:oil-oil/oil-cli update            # Update installed skills
npx github:oil-oil/oil-cli status            # Show versions and account info
npx github:oil-oil/oil-cli help              # List all commands
```

Works with Claude Code, Codex, Cursor, WorkBuddy, and other agents. It finds their skill directories automatically, or you can choose one with `--to`. Only one copy is kept per machine: it goes in the Claude Code directory when available, and the other agents link to it, so one update covers all of them. `~/.agents/skills` is used only with `--to agents`. Output follows your system language; use `--lang zh` or `--lang en` to choose one. Runs on macOS, Linux, and Windows.

## License

[MIT](LICENSE)
