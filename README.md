# atril.syn

**Your agents' terminals, alive on every machine.**

Atril is a terminal for people who run coding agents (Claude Code, Codex, OpenCode, Gemini…) and
shells on more than one machine. A sidebar shows every session and what it is doing: working,
waiting for you, finished. **Closing a tab does not kill anything**: the program keeps running in
the Atril daemon until it ends, you press Ctrl-C inside it, or you kill it on purpose. Find it again
by name, command or pid and pick up where it was.

Built with [Synsema](https://synsema.dev): the daemon, the CLI and the server are Synsema programs.

## Status: v0.1 prototype, one machine

- [x] Daemon that owns the pseudo-terminals (ConPTY on Windows, openpty on Linux/macOS)
- [x] Sessions that outlive their windows, with scrollback replayed on attach
- [x] Web UI (xterm.js): sidebar of sessions grouped as agents / terminals, tabs, search (Ctrl+Shift+K)
- [x] Agent detection by program, state from activity and terminal bell, title from OSC
- [x] `atr` CLI: `open`, `run`, `ls`, `kill`, `rm`, `up`, `down`
- [x] Local-only security model (see [SECURITY.md](SECURITY.md))
- [x] Installers: Windows (Start menu, PATH, daemon at sign-in) and Linux/macOS (systemd user service)
- [ ] Installable PWA, `.msi`/`.dmg`, signed binaries, smaller executables
- [x] `atr attach` inside your current terminal, and `atr top`: every session, live, in the terminal
- [x] Other machines through SSH: `user@host`, the password once, a link that reopens by itself
- [x] Your phone, from anywhere: `atr pair` shows a QR; the phone opens this machine's window through
      a relay, encrypted end to end (the relay sees nothing; see [SECURITY.md](SECURITY.md))
- [ ] Phone: push when an agent needs you; the app pinned and updated only when signed

## Install

**Windows 10 / 11**, the newest release, from PowerShell (no admin, and no SmartScreen warnings: files
PowerShell downloads carry no "from the internet" mark):

```powershell
irm https://synsema.github.io/atril/install.ps1 | iex
```

Or download `atril-<version>-windows-x64.zip` from [Releases](https://github.com/SYNSEMA/atril/releases),
unzip it and open **Instalar Atril**.

**Windows, from this checkout** (with the Synsema engine v0.6.44+ to build):

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It installs `atr.exe` (the command line) and `atrild.exe` (the daemon, which is also the Start menu
entry) in `%LOCALAPPDATA%\Atril`, puts `atr` on your PATH, adds **Atril** to the Start menu and
starts the daemon when you sign in. No admin.
`install.ps1 -Uninstall` removes it.

To publish a version: `.\release.ps1 -Title "…"` builds, zips `dist\` with the installer
(`atril-<version>-windows-x64.zip`, with **Instalar Atril.cmd** inside) and creates the GitHub release
`v<version>`; the site, [its site](https://synsema.github.io/atril/), shows it by itself. `-DryRun` only builds the zip.

**Linux / macOS / a server or VPS**, the newest release, for this user (no root):

```sh
curl -fsSL https://synsema.github.io/atril/install.sh | sh
```

It installs the Synsema engine if missing and builds atr + atrild into `~/.local/bin`; on Linux a
systemd user service and lingering keep your sessions up after you log out.
`… | sh -s -- --uninstall` removes it. From this checkout: `./install.sh`.

## Use

```sh
atr claude                     # Claude Code in a new session here, in this terminal (SSH too);
                               # Ctrl+] lets go of it and it keeps running; the app shows it
atr attach <session>           # back into it, from any terminal (without a session: the only one
                               # running, or the list to choose)
atr top                        # every session of this machine, live, in this terminal: ↑↓ choose,
                               # Enter goes in, Ctrl+] back to the list, n new shell, x ends one
atr run --name review claude   # a session running Claude Code
atr name 2 "migración de la base"   # a title for a session, to remember it and find it
atr run                        # your shell
atr ls                         # every session: name, pid, state
atr open review                # the window, on that tab (or Atril from the Start menu)
atr kill review                # end the program
atr down                       # stop the daemon and every session
atr pair                       # a QR for your phone: it opens this machine's window from anywhere
atr devices                    # the paired phones; `atr devices rm <id>` cuts one at once
```

**A server, in the same window**: on your computer, **+ conectar máquina** → `user@ip` (and the
port, if it is not 22). If the server has no Atril yet, the dialog offers to install it there, with
the engine, in that user's `~/.local`, no root. If it asks for the password, it is used once to leave Atril's
own SSH key there and is not kept. The server shows up in the sidebar with its spaces and agents,
and the link stays open and reopens by itself (see [SECURITY.md](SECURITY.md)).

On the server itself, `atr top` (or plain `atr`, which shows it when there is no screen) lists its
sessions live and lets you go into any of them.

Without a window on your side, the old way still works (the daemon only listens on the server's
127.0.0.1):

```sh
ssh -L 7172:127.0.0.1:7171 my-server
atr url                        # on the server: the address with its key; change 7171 to 7172
```

From the source without installing: `cli/atr` (`cli\atr.cmd` on Windows) runs the same commands
through the engine.

## How it works

```
 window (browser / app / phone)            daemon (one per machine)
 ┌────────────────────────┐   socket   ┌──────────────────────────────────────┐
 │ xterm.js  ── keys ─────┼──────────▶ │ attach handler ── bus in.<id> ──┐    │
 │           ◀─ output ───┼────────────┤                 ◀─ bus out.<id> ┤    │
 └────────────────────────┘            │                                 ▼    │
   closing it ends only this socket    │   Session agent (own thread) ── PTY ── claude
                                       └──────────────────────────────────────┘
```

Each session is a Synsema `agent` that owns one pseudo-terminal and keeps the last 512K characters
of output. A window only subscribes to the session's output on the in-process bus and publishes keys
to it; on attach the session sends a snapshot and the window drops the output that the snapshot
already contains (by sequence number). If the daemon stops, its sessions stop with it, as with tmux.

```
src/atrild.syn      the daemon (and the Start menu entry)
src/atr.syn         the CLI (cli/atr, cli/atr.cmd launch it from the source)
src/window.syn      opens the window; shared by both
src/ui/             the window
```

In the window each **machine** has a tab (this computer, the servers you connected, **+** to
connect another); a **space** is a folder (with its git branch), its **tabs** are the sessions that run
there (+ asks for an optional title; double-click a tab to change it), and **agents** lists only
agents, from every space of every machine, plus the agents that run **outside Atril** (seen, not
attachable: start them with `atr claude` to have them). **new** opens a picker with your recent repositories and a folder browser.

**archivos** (Ctrl+Shift+E) opens a panel on the right with the files of the space on screen: what git
sees changed (modified, new, deleted) listed first, then the tree with the same colors. A click opens
the file with its colors, or its diff since the last commit; it updates by itself while an agent writes.
Read only, and only inside your spaces; it works on the other machines too (with this version of Atril there).
It floats over the terminal (a program that lays itself out by width, like OpenCode, keeps its layout);
**fijar** docks it beside the terminal instead.

**◐ tema**, at the bottom of the sidebar: dark, light, paper, high contrast, or yours, and either one
always or one for the day and one for the night (by the system's setting or by the hour). A theme is a
JSON file: put yours in `~/.atril/themes/`; [src/ui/themes/README.md](src/ui/themes/README.md) explains
every color, the terminal's and the selection's included.

## License

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)); third-party software in the window:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The future relay will be AGPL-3.0.
