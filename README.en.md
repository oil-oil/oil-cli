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

Works with Claude Code, Codex, DeepSeek Harness, Cursor, WorkBuddy, and other agents. It finds their skill directories automatically, or you can choose one with `--to`. Only one copy is kept per machine: it goes in the Claude Code directory when available, and the other agents link to it (`~/.agents/skills` is used by default for Codex, DeepSeek Harness, and other `.agents`-compatible hosts; `--to codex` and `--to dsh` use `~/.codex/skills` and `~/.dsh/skills`, respectively), so one update covers all of them. Status checks and updates also scan existing user-level `~/.dsh/skills` and project-level `.dsh/skills` installations. Companion skills included with a paid skill (such as `oil-art-landing`, included with Oil UI Pro) are installed to the same locations when the paid skill is installed or updated; if a companion cannot be installed yet (not signed in, inactive license, failed download, or an occupied folder), only that companion is skipped with a warning and the paid skill is unaffected. Output follows your system language; use `--lang zh` or `--lang en` to choose one. Runs on macOS, Linux, and Windows.

## License

[MIT](LICENSE)
