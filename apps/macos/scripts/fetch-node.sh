#!/bin/bash
# Baixa o Node.js oficial para Apple Silicon que vai embutido no app.
#
#   ./scripts/fetch-node.sh <pasta-de-destino>     # cria <destino>/bin/node
#
# A versão e o SHA-256 ficam fixos aqui: o build falha se o arquivo baixado não
# for exatamente o publicado em nodejs.org/dist/v<versão>/SHASUMS256.txt.
# O binário entra no app sem modificação e sem nova assinatura — continua
# assinado pela Node.js Foundation, o que dá para conferir com `codesign -dv`.
set -euo pipefail

NODE_VERSION="22.23.5"
NODE_SHA256="e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d"   # node-v22.23.5-darwin-arm64.tar.gz

DEST="${1:?uso: fetch-node.sh <pasta-de-destino>}"
NAME="node-v${NODE_VERSION}-darwin-arm64"
CACHE="${CLAUDE_HUB_CACHE:-$HOME/Library/Caches/claude-hub-build}"
TARBALL="$CACHE/$NAME.tar.gz"

mkdir -p "$CACHE" "$DEST/bin" "$DEST/licenses"

check() { echo "$NODE_SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null 2>&1; }

if ! { [[ -f "$TARBALL" ]] && check; }; then
  echo "→ Baixando Node ${NODE_VERSION} (arm64) de nodejs.org…"
  curl -fL --retry 3 --silent --show-error -o "$TARBALL" "https://nodejs.org/dist/v${NODE_VERSION}/$NAME.tar.gz"
fi
if ! check; then
  echo "ERRO: o SHA-256 de $TARBALL não confere com o valor fixado. Abortando." >&2
  rm -f "$TARBALL"
  exit 1
fi
echo "✓ SHA-256 confere ($NODE_SHA256)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TARBALL" -C "$WORK" "$NAME/bin/node" "$NAME/LICENSE"
# ditto preserva a assinatura original do binário.
ditto "$WORK/$NAME/bin/node" "$DEST/bin/node"
cp "$WORK/$NAME/LICENSE" "$DEST/licenses/node-LICENSE.txt"

ARCHS="$(lipo -archs "$DEST/bin/node")"
if [[ "$ARCHS" != "arm64" ]]; then
  echo "ERRO: esperava um binário arm64, veio: $ARCHS" >&2
  exit 1
fi
codesign --verify --strict "$DEST/bin/node"
SIGNER="$(codesign -dv --verbose=2 "$DEST/bin/node" 2>&1 | grep -E '^(Authority|TeamIdentifier)=' | head -2 | tr '\n' ' ')"
echo "✓ Node $("$DEST/bin/node" --version) · $ARCHS · assinatura original válida · $SIGNER"
