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

Installing or updating Oil UI Pro automatically removes the open source version from the same Agent's user and current project directories. Custom directories only clean their own location; development directories, symbolic links, and unrecognized directories with the same name are skipped.

## License

[MIT](LICENSE)
