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

Output follows your system language; use `--lang zh` or `--lang en` to choose one. Codex installs follow `CODEX_HOME`.

Supports Claude, Codex, agents, Cursor, and WorkBuddy. Without `--to`, existing user directories are detected; `--to workbuddy` installs to `~/.workbuddy/skills`. WorkBuddy currently supports the user directory only: its official [project configuration guide](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project) lists `.codebuddy/skills`, without confirming project-level `.workbuddy/skills`. The latter is not scanned or cleaned automatically; explicit paths are treated as custom directories.

Installing or updating Oil UI Pro automatically removes the open source version from the same Agent's user and current project directories. Custom directories only clean their own location; development directories, symbolic links, and unrecognized directories with the same name are skipped.

Supports Windows, macOS, and Linux. On Windows, the home directory uses `USERPROFILE`, then `HOME`; configuration is stored at `%APPDATA%\oil\config.json` and inherits the directory ACL (POSIX uses `0600`). Extraction uses the system `tar.exe`; junctions receive the same cleanup protection as symbolic links.

Generated Windows commands quote paths for PowerShell. Programs launching the CLI should invoke `npx.cmd` through `cmd.exe`, or run npm's `bin/npx-cli.js` with Node. Node's `execFile` cannot execute `.cmd` files directly.

## License

[MIT](LICENSE)
