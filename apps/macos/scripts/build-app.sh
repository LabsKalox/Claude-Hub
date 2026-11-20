#!/bin/bash
# Monta build/ClaudeHub.app só com as Command Line Tools (sem abrir o Xcode):
# compila com SwiftPM, cria o bundle, gera o ícone, embute o runtime (opcional)
# e assina.
#
#   ./scripts/build-app.sh                                  # só a ilha (desenvolvimento)
#   CLAUDE_HUB_RUNTIME=/caminho/runtime ./scripts/build-app.sh   # com hub + Node embutidos
#
# Assinatura:
#   CODESIGN_IDENTITY="-"  (padrão) assinatura local ("ad-hoc"): serve para o Mac
#                          onde o app foi compilado. NÃO passa pelo Gatekeeper
#                          quando o app é baixado da internet.
#   CODESIGN_IDENTITY="Developer ID Application: Nome (TEAMID)"  assinatura para
#                          distribuição; exige certificado da Apple e notarização
#                          (feita em package-dmg.sh).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script só roda no macOS." >&2
  exit 1
fi

CONFIG="${CONFIG:-release}"
APP="build/ClaudeHub.app"
ICONS="Sources/ClaudeHub/Assets.xcassets/AppIcon.appiconset"
IDENTITY="${CODESIGN_IDENTITY:--}"
RUNTIME="${CLAUDE_HUB_RUNTIME:-}"

echo "→ Compilando (${CONFIG})…"
swift build -c "$CONFIG" --product ClaudeHub
BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"

echo "→ Montando ${APP}…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/ClaudeHub" "$APP/Contents/MacOS/ClaudeHub"
cp Support/Info.plist "$APP/Contents/Info.plist"

# Os PNGs já seguem os nomes que o iconutil espera (icon_16x16.png, …@2x.png).
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/AppIcon.iconset"
cp "$ICONS"/icon_*.png "$WORK/AppIcon.iconset/"
iconutil -c icns "$WORK/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

if [[ -n "$RUNTIME" ]]; then
  for required in hub.mjs claude-hub.mjs claude-hub-hook.mjs claude-hub-statusline.mjs claude-hub-opencode.js web/index.html bin/node bin/claude-hub; do
    if [[ ! -e "$RUNTIME/$required" ]]; then
      echo "ERRO: runtime incompleto, falta $RUNTIME/$required" >&2
      exit 1
    fi
  done
  echo "→ Embutindo o runtime (hub, CLI, hook, PWA e Node)…"
  # ditto preserva permissões e a assinatura original do Node.
  ditto "$RUNTIME" "$APP/Contents/Resources/runtime"
fi

NODE_BIN="$APP/Contents/Resources/runtime/bin/node"
# Permissões declaradas do app: só o envio de Apple Events (controles do widget de música).
APP_ENTITLEMENTS=()
if [[ -f Support/ClaudeHub.entitlements ]]; then
  plutil -lint Support/ClaudeHub.entitlements >/dev/null
  APP_ENTITLEMENTS=(--entitlements Support/ClaudeHub.entitlements)
fi
if [[ "$IDENTITY" == "-" ]]; then
  # Build de teste: o Node embutido mantém a assinatura original da Node.js Foundation.
  echo "→ Assinando localmente (ad-hoc, hardened runtime)…"
  codesign --force --sign - --options runtime ${APP_ENTITLEMENTS[@]+"${APP_ENTITLEMENTS[@]}"} "$APP"
else
  # Distribuição: a notarização exige Developer ID, hardened runtime e carimbo de
  # tempo em todo executável. O código aninhado é assinado antes do app.
  if [[ -n "$RUNTIME" ]]; then
    echo "→ Assinando o Node embutido com \"$IDENTITY\"…"
    codesign --force --sign "$IDENTITY" --options runtime --timestamp \
      --entitlements Support/node.entitlements "$NODE_BIN"
  fi
  echo "→ Assinando o app com \"$IDENTITY\" (hardened runtime, carimbo de tempo)…"
  codesign --force --sign "$IDENTITY" --options runtime --timestamp ${APP_ENTITLEMENTS[@]+"${APP_ENTITLEMENTS[@]}"} "$APP"
fi
codesign --verify --strict "$APP"
if [[ -n "$RUNTIME" ]]; then
  codesign --verify --strict "$NODE_BIN"
  "$NODE_BIN" -e 'process.exit(0)'   # o Node precisa continuar executando depois de assinado/embutido
fi

echo "Pronto: $(pwd)/${APP}"
