#!/bin/sh
# Atril for Linux and macOS (a server, a VPS, your laptop), from the terminal, for this user (no root):
#
#   curl -fsSL https://atril.dev/install.sh | sh
#
# It installs the Synsema engine when it is missing, downloads the source of the newest release and
# runs its src/install.sh: atr + atrild built into ~/.local/bin and, on Linux with systemd, a user
# service that keeps the daemon (and your sessions) up, also after you log out of a server.
# Source: https://github.com/SYNSEMA/atril
#
#   curl -fsSL https://atril.dev/install.sh | sh -s -- --uninstall    removes it

# everything in one function, called on the last line: a download cut halfway runs nothing
atril_install() {
  set -eu
  REPO="SYNSEMA/atril"
  say() { printf 'atril: %s\n' "$*"; }
  need() { command -v "$1" >/dev/null 2>&1 || { say "falta '$1': instalalo y probá de nuevo"; exit 1; }; }
  need curl
  need tar

  # the engine's installer puts synsema in ~/.local/bin
  export PATH="$HOME/.local/bin:$PATH"

  if [ "${1:-}" = "--uninstall" ]; then
    if [ -x "$HOME/.local/bin/atr" ]; then "$HOME/.local/bin/atr" down >/dev/null 2>&1 || true; fi
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable --now atril.service >/dev/null 2>&1 || true
    fi
    rm -f "$HOME/.config/systemd/user/atril.service" "$HOME/.local/bin/atr" "$HOME/.local/bin/atrild"
    say "Atril quitado. Tus ajustes en ~/.atril quedaron."
    exit 0
  fi

  if ! command -v synsema >/dev/null 2>&1; then
    say "instalando el motor de Synsema"
    curl -fsSL https://synsema.com/install.sh | sh
  fi
  command -v synsema >/dev/null 2>&1 || { say "no encuentro synsema después de instalarlo: abrí otra terminal y probá de nuevo"; exit 1; }

  # the newest release's tag, without jq
  TAG=$(curl -fsSL -H "User-Agent: atril-install" "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$TAG" ] || { say "no pude saber cuál es la última versión (GitHub no respondió)"; exit 1; }

  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t atril)
  trap 'rm -rf "$TMP"' EXIT INT TERM
  say "bajando Atril $TAG"
  curl -fsSL "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz" | tar -xz -C "$TMP"
  SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -f "$SRC/src/install.sh" ] || { say "la versión $TAG no trae src/install.sh"; exit 1; }

  say "compilando e instalando (un par de minutos)"
  sh "$SRC/src/install.sh"
  say "listo: 'atr' para la lista de comandos, 'atr top' para tus sesiones"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "nota: agregá ~/.local/bin a tu PATH (o abrí otra terminal) para usar 'atr'" ;;
  esac
}

atril_install "$@"
