#!/bin/bash
# Constrói o instalador do Claude Hub — para rodar NA NUVEM (GitHub Actions,
# runner macOS Apple Silicon), não no Mac de quem vai usar o app.
#
# Compila hub, CLI e PWA, monta o runtime, compila o app e gera
#   apps/macos/build/ClaudeHub-<versão>-arm64.dmg  (+ .sha256)
#
# Não instala nada na máquina onde roda.
set -euo pipefail

cd "$(dirname "$0")/.."

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo "Requer macOS Apple Silicon (arm64)." >&2; exit 1; }

echo "→ Dependências"
pnpm install --frozen-lockfile
echo "→ Hub, CLI e PWA"
pnpm build
echo "→ Runtime embutido"
pnpm bundle:runtime
echo "→ App e instalador"
apps/macos/scripts/package-dmg.sh
