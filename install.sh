#!/bin/sh
# install.sh — installs Atril on Linux or macOS for this user (no root), from this checkout.
#
#   ./install.sh              build atr + atrild into ~/.local/bin; on Linux with systemd, a user
#                             service keeps the daemon up (and lingering keeps it up after you log out
#                             of a server)
#   ./install.sh --uninstall  remove all of it (running sessions end)
#
# Needs the Synsema engine v0.6.44+ (https://synsema.dev) to build.
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
BIN="${ATRIL_BIN:-$HOME/.local/bin}"
UNIT="$HOME/.config/systemd/user/atril.service"
has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

stop_atril() {
  if [ -x "$BIN/atr" ]; then "$BIN/atr" down >/dev/null 2>&1 || true; fi
  if has_systemd; then systemctl --user stop atril.service >/dev/null 2>&1 || true; fi
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_atril
  if has_systemd; then systemctl --user disable atril.service >/dev/null 2>&1 || true; fi
  rm -f "$UNIT" "$BIN/atr" "$BIN/atrild"
  echo "Atril removed. Your settings in ~/.atril were kept."
  exit 0
fi

command -v synsema >/dev/null 2>&1 || { echo "install.sh: needs the Synsema engine (https://synsema.dev)"; exit 1; }

stop_atril
mkdir -p "$BIN"
( cd "$ROOT/src" && synsema build atrild.syn -o "$BIN/atrild" --serve && synsema build atr.syn -o "$BIN/atr" )

if [ "$(uname)" = "Linux" ] && has_systemd; then
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Atril daemon: keeps your terminal sessions alive

[Service]
ExecStart=$BIN/atrild --background
Restart=on-failure
WorkingDirectory=%h

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now atril.service
  # on a server: keep the user's services (and your sessions) running after you log out
  loginctl enable-linger "$(id -un)" 2>/dev/null || echo "note: 'loginctl enable-linger' failed; your sessions end when you log out (ask an admin to run it)"
else
  "$BIN/atr" up
fi

echo
echo "Atril is installed in $BIN"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "  add it to your PATH:  export PATH=\"$BIN:\$PATH\"" ;; esac
echo "  atr run claude    a session that outlives your SSH connection"
echo "  atr ls            your sessions;  atr url  the window's address (open it through ssh -L)"
