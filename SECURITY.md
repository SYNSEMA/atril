# Security model

A terminal you can reach from somewhere else is a shell, and whoever reaches it has the power of
your user on that machine. Atril is built around one question: **who can open a terminal?**

## v0.1 — one machine (what exists today)

| Threat | What stops it | Verified |
|---|---|---|
| Someone who knows your IP scans for the port | The daemon binds **127.0.0.1 only**. From the network there is no port to find | `curl http://<LAN IP>:7171` → connection refused |
| Another program on your machine calls the API | Every route except the static UI needs the **key** (32 random bytes, new at every start, in `~/.atril/daemon.json`) | no key → 401 |
| A web page you visit talks to `127.0.0.1:7171` (CSRF, cross-site WebSocket hijacking) | `Origin` must be the daemon's own origin; the UI's cookie is `HttpOnly` + `SameSite=Strict` | `Origin: https://evil.com` with the right key → 401 |
| DNS rebinding (`evil.com` resolving to 127.0.0.1) | `Host` must be `127.0.0.1:7171` or `localhost:7171` | `Host: evil.com:7171` → 401 |
| A window sends something other than keys | The attach socket forwards only `{keys}` and `{resize}` (validated sizes); killing is a separate, authenticated route | a `{"t":"kill"}` sent over the socket is dropped |

**Another person who also uses Atril** runs their own daemon on their own computer, with their own
key. In v0.1 there is no path at all between two daemons: neither listens on the network, and
neither knows the other exists. Two people on the **same** computer (two Windows accounts) share
127.0.0.1, but the key lives in each one's profile folder, which the other account cannot read.

Known gaps, in order:
- `~/.atril/daemon.json` relies on your home folder being private; on Linux/macOS it should be `chmod 600`.
- `atr open` passes the key in the URL fragment on the browser's command line, visible to other
  processes of the same user for a moment.
- Any process running **as you** can read the key. Atril does not defend you from your own user;
  nothing on a desktop OS does.

## Other machines through SSH (built)

**Conectar máquina** asks for `user@host`. Nothing new listens anywhere: the other machine's daemon
still listens on its own 127.0.0.1, and this computer reaches it through an SSH tunnel.

- **Atril has its own key** (`~/.atril/ssh/id_ed25519`, made the first time) and its own
  `known_hosts`. A machine's host key is accepted the first time and pinned: if it changes, Atril
  refuses to connect.
- **The password is used once.** When the machine asks for one, the window sends it to this daemon,
  which types it into `ssh` (in a pseudo-terminal) to add Atril's public key to that machine's
  `~/.ssh/authorized_keys`, and keeps it nowhere: not on disk, not in a log, not in the window.
- **The link stays open**: one `ssh -N -L` per machine, with keepalives every 15 s. This daemon checks
  it every 20 s and opens it again when it drops (a reboot of the server, a laptop that slept), waiting
  longer each time up to 30 s. Tested: a server restart comes back in ~4 s; a frozen server is noticed
  in under a minute and comes back seconds after it answers again.
- **The other daemon's key** is read through SSH each time the link opens and kept in memory only.
- **Installing Atril on a machine that has none** (when you accept it in the dialog): the sources go
  from this computer to that machine, not from the internet. `ssh -R` gives the machine a port on
  its own 127.0.0.1 that leads to this daemon, and its `curl` fetches each file of a fixed list with
  a key made for that one install and dropped when it ends; the route answers nothing else, and
  nothing without that key. The Synsema engine comes from its official installer when it is missing.
- **Whoever can open the window of this computer can use the connected machines.** That is the same
  key as before (127.0.0.1, the token in `~/.atril/daemon.json`). Disconnecting a machine forgets it
  here; to cut Atril out of it entirely, remove the `atril@…` line from its `authorized_keys`.

## Your phone, through a relay (built)

A phone on mobile data cannot reach a computer behind a home router, and the daemon still listens on
127.0.0.1 only. So both connect **out** to a relay that joins them, and the relay is not trusted:
everything between the phone and the daemon is encrypted end to end, with keys the relay never has.
Where the relay runs (ours at `atril.synsema.io`, or yours) decides availability, not security.

| Threat | What stops it | Verified |
|---|---|---|
| The relay (or whoever breaks into it) reads a terminal or types into one | It only carries sealed records: AES-256-GCM with keys from a handshake it cannot complete (below) | a record with one byte changed does not open and ends the connection (`src/remote_test.syn`) |
| A relay that answers in the daemon's place | The QR pins the daemon's public key; without its private half the keys do not match and the first record does not open | an impostor without the key cannot derive them (`remote_test.syn`) |
| Someone who connects to the relay with the room of your daemon | The daemon talks only to a phone whose key it paired, or that brings a valid pairing code | an unpaired browser gets "not paired" and nothing else |
| A stolen key, later, opens what was recorded before | Every connection adds two fresh ephemeral keys (forward secrecy) | — (by construction: DH(Ep, Ed) dies with the connection) |
| A phone you lost | `atr devices rm <id>` on the computer: its connection is cut at once and it cannot come back | revoked in the end-to-end test: the next request fails, the phone stops retrying |
| A paired phone pairs others, removes phones, stops the daemon, reads the sources | Those routes answer 403 to a phone; pairing is done only from the computer | 403 on `/api/remote/*`, `/api/shutdown`, `/api/source/*` from the phone |
| The page the phone runs is changed on the way | The app is served from its own origin (`app.atril.synsema.io`, static files built from this repository by `src/app/build.sh`), never by the relay: breaking into the relay does not change the code that holds the keys | — |
| Moving the phones to another relay | Only the computer chooses the relay (`/api/remote/relay` answers 403 to a phone); the phones connected at that moment learn the new address inside a sealed record, so a relay cannot send them elsewhere | moved to a local relay and back in the end-to-end test: the phone followed both times |

**Pairing.** `atr pair` shows a QR with the relay, the room (derived from the daemon's public key),
that key, a one-use code valid 5 minutes and the machine's name, all in the URL fragment (it never
reaches a server). The phone makes its own X25519 key in the browser, **not exportable**, kept in that
origin's storage. The daemon keeps the public half in `~/.atril/remote-devices.json`.

**Handshake** (`src/remote.syn`, `src/app/remote.js`; like Noise KK). Each side brings an ephemeral key
(Ep, Ed) and 16 random bytes; with h = SHA-256 of every public value:
`ck1 = HKDF(DH(Ep, D), h)` (only the real daemon), `ck2 = HKDF(DH(P, Ed), ck1)` (only the paired phone),
and one key per direction `HKDF(DH(Ep, Ed), ck2)`. Records carry a counter in the nonce: one out of
order, repeated or changed ends the connection. The daemon speaks first, so the phone knows the keys
match before it sends anything.

**What the phone can do.** Whatever the window can, and nothing else: each request goes to this
daemon's own API on 127.0.0.1 with its key, so every check of the window applies to the phone too.

**The relay** (`src/relay.syn`) keeps nothing: no file, no database, no outgoing connection. Its
`require` block is `serve`, `time`, `random`. Ours is `atril.synsema.io`; yours runs with one command
(the header of `relay.syn`, or **Agregar dispositivo → Teléfono → cambiar** in the window, which tests
it and shows how long a message takes to come back before you use it).

Known gaps, in order:
- A relay can refuse service (drop the frames); it cannot read or change them.
- The relay accepts the first daemon that connects to a room. The room's name is only in the QR, and a
  squatter would only block it (it cannot complete a handshake). A signature from the daemon is next.
- The first load of the web app trusts the server of `app.atril.synsema.io` and its certificate. The
  Android app (next) carries the same files inside, signed: no server is trusted for the code.
- The daemon may open connections to any host (`require net("*")`), because the relay is yours to
  choose. Only the Remote agent connects out, and only to the relay in `~/.atril/remote.json`.
- Read-only sharing of one session and an audit log of phone actions are not built yet.

The hosted relay at synsema.com will add teams, SSO and retention; the encryption above is in the
free version too. Security is not what we charge for.

## Reporting

Use GitHub's private vulnerability reporting on this repository. Please do not open a public issue
for a vulnerability.
