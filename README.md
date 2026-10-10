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
- [ ] Desktop app (`synsema build --serve --no-console`) and installable PWA
- [ ] `atr attach` inside your current terminal
- [ ] Other machines through an end-to-end encrypted relay (v0.2)
- [ ] Phone: key bar is there; push when an agent needs you (v0.3)

## Try it

Needs the Synsema engine (v0.6.44+): https://synsema.dev

```sh
cli/atr up                       # starts the daemon (127.0.0.1:7171)
cli/atr run --name review claude # a session running Claude Code
cli/atr run                      # your shell
cli/atr ls
cli/atr open review              # the window, on that tab
cli/atr kill review
```

On Windows use `cli\atr.cmd`.

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
daemon/atrild.syn   the daemon
daemon/ui/          the window
cli/atr.syn         the CLI (cli/atr, cli/atr.cmd launch it)
```

## License

Apache-2.0. The future relay will be AGPL-3.0.
