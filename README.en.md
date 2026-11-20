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

Works with Claude Code, Codex, DeepSeek Harness, Cursor, WorkBuddy, and other agents. It finds their skill directories automatically, or you can choose one with `--to`. Only one copy is kept per machine: it goes in the Claude Code directory when available, and the other agents link to it (`~/.agents/skills` is used by default for Codex, DeepSeek Harness, and other `.agents`-compatible hosts; `--to codex` and `--to dsh` use `~/.codex/skills` and `~/.dsh/skills`, respectively), so one update covers all of them. Status checks and updates also scan existing user-level `~/.dsh/skills` and project-level `.dsh/skills` installations; `update` also accepts `<skill>` or `--path <directory>` to update a single installation. Companion skills included with a paid skill (such as `oil-art-landing`, included with Oil UI Pro) share the main paid skill's license: installing the main paid skill lists any included companions before confirmation and installs them to the same locations, and `update` (including `update --path`, which also links the companion into other user-level agent directories linked to that same main installation) automatically adds any missing companions. A companion skill can also be installed on its own with `install`, and only installing or updating the main paid skill removes the open source version from the same agent—installing a companion skill alone keeps the open source version. If a companion cannot be installed yet (not signed in, inactive license, failed download, or an occupied folder), only that companion is skipped with a warning (without prompting for sign-in during `update` when only companions are pending), leaving the main paid skill and other updates unaffected; if updating an installed companion skill returns HTTP 402 (not purchased or inactive license), the prompted `subscribe` command and purchase URL point to the main paid skill. Output follows your system language; use `--lang zh` or `--lang en` to choose one. Runs on macOS, Linux, and Windows.

## License

[MIT](LICENSE)
