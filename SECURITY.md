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

## v0.3 — other machines without SSH (designed, not built)

For machines you cannot reach by SSH (a computer behind a home router, a phone). No machine ever
opens a port. Each daemon keeps **one outbound** encrypted connection to a relay
(the same design as `syn tunnel`), so a laptop behind NAT, a VPS and a phone meet without inbound
firewall rules. Knowing an IP gives an attacker nothing to connect to.

1. **Pairing.** A new device (phone, another laptop) is added by scanning a QR or typing a short code
   shown by a machine you already control, and approving it there. Each device has its own key pair;
   the private key never leaves it.
2. **End-to-end encryption.** Terminal bytes are encrypted between the device and the daemon with
   keys the relay never sees (Noise / X25519 + ChaCha20-Poly1305). The relay routes ciphertext: it
   cannot read your sessions nor type into them, and neither can anyone who breaks into it.
3. **Pinned keys.** The device knows the daemon's public key and the daemon knows the device's. A
   relay that swaps keys is detected and the connection refused.
4. **Revocation.** Removing a device on any machine you control cuts it everywhere.
5. **Read-only sharing.** A session can be shared to watch, without the right to type.
6. **Audit.** Every attach, every device, every kill is logged on the machine that owns the session.

The hosted relay at synsema.com will add teams, SSO and retention; the encryption above is in the
free version too. Security is not what we charge for.

## Reporting

Use GitHub's private vulnerability reporting on this repository. Please do not open a public issue
for a vulnerability.
