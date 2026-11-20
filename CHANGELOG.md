# Changelog

All notable changes to Claude Hub by Kalox. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, minor versions may change behavior.

Installers are built only on GitHub Actions (macOS Apple Silicon runners). None of them is signed with an Apple Developer ID or notarized — see [Installing](README.md#installing).

## [0.5.2] — 2026-11-20

### Added
- **Codex: token usage, plan limits (5 h and weekly), task errors and plan progress.** They are read from the session file Codex itself writes (`$CODEX_HOME/sessions`), read-only. Codex does not call the `Stop` hook when a turn fails, so errors used to leave the session "Working".
- **OpenCode: token usage and cost** for each response (1.x `message.updated`, 2.x `session.step.ended`). OpenCode has no plan limits; the Usage tab says so.
- Usage tab (Mac and iPhone) with Codex and OpenCode sections.
- **Island height fine-tuning**: menu bar → *Ajustar altura da ilha…* moves the island live, so it lines up with your browser's toolbar.
- Real-agent CI now also checks errors, progress, tokens and limits, with three simultaneous sessions.

### Fixed
- OpenCode: the "idle" event sent right after an error no longer turns *Error* into *Done*; error messages are shown as text, not JSON.
- OpenCode 2.x with several folders open: each plugin instance now handles only its own folder. Before, approvals could be duplicated and project names mixed up.

## [0.5.1] — 2026-11-20

First public release. Includes everything from the 0.5.0 test build plus the fixes below.

### Fixed
- OpenCode 2.x: a finished session stayed "Working" — 2.x announces the end of a run with `session.execution.succeeded`/`interrupted`, not `session.idle`. Found by the real-agent test.
- OpenCode 2.x permission requests use the `shell`/`subagent` action names; they are now shown as Bash/Task.
- OpenCode plugin: events from one session are delivered in order, and a title that arrives late updates the session.

### Changed
- The island uses the project's own eight-ray star again instead of the Claude logo (a third-party trademark).
- The approval card's "answer in the terminal" link names the agent ("Responder no Codex").

### Added
- Real-agent CI (`Agentes reais`): the real Codex CLI 0.171.0, OpenCode 1.19.6 and OpenCode 2.3.2, on macOS and Linux, each with two simultaneous sessions, one request allowed and one denied from the "iPhone".
- Screenshots of the island with Claude Code, Codex and OpenCode sessions at the same time.

## [0.5.0] — 2026-11-20 (test build, not published)

### Added
- **OpenAI Codex CLI integration** through Codex's official command hooks (`~/.codex/hooks.json`): sessions, tool calls, permission requests and remote allow/deny. Codex asks the user to trust new hooks before running them; Claude Hub never bypasses that.
- **OpenCode integration** (V1 `opencode-ai` and V2 `@opencode/cli`) through a single plugin file dropped into `~/.config/opencode/plugins/`: sessions, tool calls, to-dos, errors, permission requests and remote allow/deny. Answering in the terminal cancels the request on the island and the phone.
- Setup assistant block "Codex and OpenCode" and the `agents` CLI command to turn each integration on or off. *Repair* refreshes outdated integrations; *Uninstall* removes them.
- Island titles and session cards name the agent ("Codex wants to use Bash").
- Automated tests that run the **real** Codex CLI and OpenCode against the hub with a local fake model (no API key).
- `THIRD_PARTY_NOTICES.txt` inside the app with the license of every bundled package.

### Changed
- Approvals and sessions store which agent produced them (database migration with a `claude-code` default).

## [0.4.3] — 2026-11-20
### Added
- iPhone notifications: step-by-step activation with a timeout and a specific message per step, on-screen state (permission, service worker, subscription), and a report of the failing step sent to the Mac.
- `push.subscribed`, `push.unsubscribed`, `push.sent`, `push.failed` in the hub log and audit trail; push status in diagnostics, health check and the `push` CLI command.
- Island position setting (default: below a maximized browser's tab bar).
### Changed
- CPU and memory are hidden by default (Sistema tab → *Show CPU and memory*).
### Fixed
- VAPID subject: the old local subject is rejected by Apple's push service (`403 BadJwtToken`, measured). Existing installs are migrated keeping the same keys.

## [0.4.2] — 2026-11-20
### Changed
- The island shows the Claude symbol instead of a generic star.

## [0.4.1] — 2026-11-20
### Fixed
- Tailscale was reported as "not connected" when it was connected: the app and the service call the Tailscale binary without a shell, and the macOS app binary only acts as a CLI with `TAILSCALE_BE_CLI=1`. Unreadable output is now shown as-is instead of "not connected", and disabled HTTPS certificates are detected before publishing.

## [0.4.0] — 2026-11-20
### Added
- Mac monitoring (Sistema tab): CPU, memory, SSD, battery, thermal state, charts and green/yellow/red indicators.
- Widgets: clock, now playing (Music/Spotify) and weather (Open-Meteo).
- Usage tab: Claude Code token usage and cost (OpenTelemetry) and plan limits (status line), only with data Claude Code reports.
- The island opens automatically when a Claude Code session starts; single instance.

## [0.3.0] — 2026-11-20
### Added
- Self-contained `.dmg` (embedded Node.js, hub, CLI, PWA) built only in the cloud; graphical setup assistant with health check, repair, diagnostics and uninstall; QR pairing.

## [0.1.0 – 0.2.0]
- Hub, Claude Code hooks bridge, iPhone PWA, native macOS island and remote approvals.
