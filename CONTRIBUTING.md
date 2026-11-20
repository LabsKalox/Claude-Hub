# Contributing to Claude Hub by Kalox

Thanks for your interest! Issues, ideas and pull requests are welcome.

## Ground rules

- **Be honest about what was tested.** Every claim in docs, release notes and pull requests must match what a test or a real run showed. Say "not verified" when it wasn't.
- **Never weaken the approval model.** Claude Hub only relays decisions a human makes. No auto-approve modes, no `updatedInput`/`updatedPermissions`, no executing commands received from notifications.
- **Use official integration points only**: Claude Code hooks, Codex hooks, OpenCode plugins. No private APIs, no patching other tools' files, no bypassing Gatekeeper or Codex's hook-trust prompt.
- **Preserve user configuration.** Anything that edits `~/.claude/settings.json`, `~/.codex/hooks.json` or OpenCode's folders must keep the user's own entries, back up before writing, and restore the file exactly on uninstall. Add a test for it.

## Project layout

| Path | What |
|---|---|
| `apps/macos` | Native island (Swift/SwiftUI), Xcode project and installer scripts |
| `apps/web` | iPhone PWA and web replica of the island (Next.js, static export) |
| `services/api` | Local hub (Node, Fastify, SQLite, WebSocket, Web Push) |
| `packages/claude-bridge` | Agent integrations (Claude Code, Codex, OpenCode), CLI, setup |
| `packages/shared` | Shared contracts |
| `tests/e2e` | Playwright tests (PWA and web island against a real hub) |
| `tests/real` | Real Claude Code / Codex / OpenCode runs; macOS smoke and install tests |

## Development

Requirements: Node.js ≥ 22.13 and pnpm 10. The macOS app is compiled by CI; you don't need Xcode to work on the hub, the bridge or the PWA.

```bash
pnpm install
pnpm build
pnpm test        # unit and integration tests
pnpm test:e2e    # Playwright (run `pnpm --filter @claude-hub/e2e exec playwright install chromium` once)
```

On a Mac with Xcode you can also run `cd apps/macos && swift build && swift test`. Details in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## CI

| Workflow | Runs |
|---|---|
| `CI (Linux)` | build, typecheck, unit/integration tests, Playwright, Docker |
| `CI macOS` | Swift build and tests, Xcode build, `.dmg`, smoke test of the real app, install/reinstall/uninstall test, Gatekeeper check |
| `Agentes reais` | the real Codex CLI and OpenCode against the hub with a local fake model |

Pull requests must keep all three green.

## Pull requests

1. One topic per PR, with a short description of *why*.
2. Add or update tests. For integrations, prefer a test that runs the real tool.
3. Update `CHANGELOG.md` under an "Unreleased" heading.
4. Code comments and docs may be in English or Portuguese; user-facing strings are currently Portuguese.

## Reporting security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
