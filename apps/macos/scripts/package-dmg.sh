#!/bin/bash
# Gera o instalador: build/ClaudeHub-<versão>-arm64.dmg com o ClaudeHub.app
# completo (ilha + hub + CLI + hook + PWA + Node para Apple Silicon).
#
# Antes: na raiz do repositório, `pnpm install && pnpm build && pnpm bundle:runtime`.
#
#   ./scripts/package-dmg.sh
#
# Assinatura e notarização (opcionais, exigem conta paga de desenvolvedor Apple):
#   CODESIGN_IDENTITY   "Developer ID Application: Nome (TEAMID)"
#   NOTARY_KEY_PATH     caminho do arquivo .p8 da chave da API do App Store Connect
#   NOTARY_KEY_ID       id da chave
#   NOTARY_ISSUER_ID    id do emissor
#
# Sem essas variáveis o resultado é um build de TESTE, assinado só localmente:
# funciona no Mac onde foi compilado; baixado da internet, o Gatekeeper bloqueia.
# Este script não remove quarentena nem altera nenhuma política do Gatekeeper.
set -euo pipefail

cd "$(dirname "$0")/.."
MACOS_DIR="$(pwd)"
REPO="$(cd ../.. && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script só roda no macOS." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Este instalador é só para Apple Silicon; compile num Mac arm64." >&2
  exit 1
fi
if [[ ! -f "$REPO/dist-runtime/hub.mjs" ]]; then
  echo "Falta o runtime. Na raiz do repositório rode: pnpm install && pnpm build && pnpm bundle:runtime" >&2
  exit 1
fi

VERSION="$(tr -d '[:space:]' < "$REPO/dist-runtime/VERSION")"
PLIST_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Support/Info.plist)"
if [[ "$VERSION" != "$PLIST_VERSION" ]]; then
  echo "ERRO: versão do runtime ($VERSION) diferente da do app ($PLIST_VERSION)." >&2
  exit 1
fi
IDENTITY="${CODESIGN_IDENTITY:--}"
DMG="build/ClaudeHub-${VERSION}-arm64.dmg"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "→ Preparando o runtime…"
ditto "$REPO/dist-runtime" "$STAGE/runtime"
rm -f "$STAGE/runtime/bin/node"
./scripts/fetch-node.sh "$STAGE/runtime"

CLAUDE_HUB_RUNTIME="$STAGE/runtime" CODESIGN_IDENTITY="$IDENTITY" ./scripts/build-app.sh
APP="build/ClaudeHub.app"

# O app precisa rodar a própria CLI: confere antes de empacotar.
"$APP/Contents/Resources/runtime/bin/claude-hub" setup status --json >/dev/null

echo "→ Criando ${DMG}…"
mkdir -p "$STAGE/dmg"
ditto "$APP" "$STAGE/dmg/ClaudeHub.app"
ln -s /Applications "$STAGE/dmg/Applications"
cat > "$STAGE/dmg/LEIA-ME.txt" <<TXT
Claude Hub ${VERSION} (Apple Silicon)

1. Arraste "ClaudeHub" para a pasta "Applications".
2. Abra o Claude Hub pela pasta Aplicativos.
3. Siga o assistente: ele instala o serviço do hub, liga o Claude Code
   (preservando suas configurações) e verifica se tudo funciona.

Nada é instalado fora do app, de ~/Library/LaunchAgents e de ~/.claude-hub.
Para remover: Claude Hub > Configuração e saúde > Desinstalar integração.
TXT
rm -f "$DMG"
hdiutil create -volname "Claude Hub" -srcfolder "$STAGE/dmg" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

if [[ "$IDENTITY" != "-" ]]; then
  echo "→ Assinando o .dmg…"
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
  if [[ -n "${NOTARY_KEY_PATH:-}" && -n "${NOTARY_KEY_ID:-}" && -n "${NOTARY_ISSUER_ID:-}" ]]; then
    echo "→ Enviando para notarização da Apple (pode levar alguns minutos)…"
    xcrun notarytool submit "$DMG" --key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    NOTARIZED="sim"
  else
    echo "AVISO: assinado com Developer ID, mas SEM notarização (faltam NOTARY_*). O Gatekeeper ainda bloqueia." >&2
    NOTARIZED="não"
  fi
else
  NOTARIZED="não"
fi

shasum -a 256 "$DMG" | awk '{print $1}' > "$DMG.sha256"

echo
echo "── Resultado ─────────────────────────────────────────────"
echo "Instalador:   $MACOS_DIR/$DMG ($(du -h "$DMG" | awk '{print $1}'))"
echo "SHA-256:      $(cat "$DMG.sha256")"
echo "Arquitetura:  $(lipo -archs "$APP/Contents/MacOS/ClaudeHub") (app) · $(lipo -archs "$APP/Contents/Resources/runtime/bin/node") (Node)"
echo "Assinatura:   $([[ "$IDENTITY" == "-" ]] && echo "local (ad-hoc) — build de teste" || echo "$IDENTITY")"
echo "Notarizado:   $NOTARIZED"
echo
echo "Avaliação do Gatekeeper (só leitura; mostra o que o macOS dirá de um download):"
spctl --assess --type execute --verbose=2 "$APP" 2>&1 | sed 's/^/  /' || true
if [[ "$NOTARIZED" != "sim" ]]; then
  echo
  echo "Este build NÃO é notarizado. Para distribuir sem bloqueio do Gatekeeper é"
  echo "preciso Developer ID + notarização (docs/SIGNING_NOTARIZATION.md)."
fi
