# Security Policy

Claude Hub relays permission requests from AI coding agents to your phone, so security bugs matter. Thank you for reporting them responsibly.

## Reporting a vulnerability

- Use GitHub's **private vulnerability reporting**: *Security* tab → *Report a vulnerability* on this repository.
- Please don't open a public issue or pull request for a vulnerability.
- Include the version, what an attacker can do, and steps to reproduce.

You'll get an acknowledgment within 7 days. Fixes are released as a new version with a note in the changelog.

## Supported versions

Only the latest release receives fixes.

## Security model, in short

- Everything runs on your Mac. The hub listens on `127.0.0.1` only: port 4317 for hooks, the Mac app and the CLI; port 4318 for the iPhone.
- The iPhone reaches the Mac through **your own Tailscale network** (`tailscale serve`), never the open internet. Devices pair with a one-time 8-character code (10-minute expiry, rate-limited) and get their own token, stored hashed and revocable.
- Each approval is bound to the exact session and request, expires (5 min by default), can be decided only once, and is recorded in an audit log with a hash chain.
- There is no auto-approve mode. A push notification never carries the power to approve; deciding requires the authenticated app.
- Integrations fail open: if the hub is down, Claude Code, Codex and OpenCode fall back to their own terminal prompts.

The full threat model and known limitations are in [`docs/SECURITY.md`](docs/SECURITY.md).

## Not covered

- The installer is **not signed with an Apple Developer ID nor notarized**. macOS blocks it when downloaded; this project never bypasses Gatekeeper.
- Anything with access to your macOS user account can read `~/.claude-hub/config.json` (mode 0600) and act as the hub.
