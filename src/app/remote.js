// remote.js — the window of Atril on a phone, talking to a daemon through a relay that learns nothing.
//
// The window (app.js and the rest of src/ui, unchanged) asks the daemon for things with fetch("/api/…")
// and new WebSocket(… "/api/…"). This file loads first and puts its own fetch and WebSocket in their
// place: anything for /api travels sealed, end to end, to the daemon paired with this phone; anything
// else (the window's own files) is fetched as usual.
//
// Pairing: `atr pair` on the computer gives a link (a QR) to this app with, in the fragment, the relay,
// the room, the daemon's public key, a one-use code and the machine's name. The fragment never reaches
// a server. This phone makes its own X25519 key, not exportable: it lives in this browser's storage for
// this origin and never leaves it. The handshake and the records are the ones in src/remote.syn.
"use strict";
(() => {
  // the window knows it runs on a phone: what only the computer can do (pair, connect machines) hides
  document.documentElement.classList.add("atril-phone");
  const PROTO = "atril-remote/v1";
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const NativeWebSocket = window.WebSocket;
  const nativeFetch = window.fetch.bind(window);
  const subtle = crypto.subtle;

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64 = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let i = 0;
    for (const p of parts) { out.set(new Uint8Array(p), i); i += p.byteLength; }
    return out;
  };
  const nonce = (n) => { const v = new Uint8Array(12); new DataView(v.buffer).setBigUint64(4, BigInt(n)); return v; };

  // ---- what this phone keeps: the pairing (public data) and its key (IndexedDB, not exportable)
  const store = {
    get() { try { return JSON.parse(localStorage.getItem("atril.remote")); } catch { return null; } },
    set(v) { try { localStorage.setItem("atril.remote", JSON.stringify(v)); } catch {} },
  };
  function idb(mode, fn) {
    return new Promise((ok, bad) => {
      const open = indexedDB.open("atril", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("keys");
      open.onerror = () => bad(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("keys", mode);
        const req = fn(tx.objectStore("keys"));
        tx.oncomplete = () => ok(req.result);
        tx.onerror = () => bad(tx.error);
      };
    });
  }
  async function deviceKey() {
    let kp = await idb("readonly", (s) => s.get("device"));
    if (!kp) {
      kp = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      await idb("readwrite", (s) => s.put(kp, "device"));
    }
    return kp;
  }

  // ---- the pairing in the link, kept; the fragment is wiped from the address bar
  function pairing() {
    const f = new URLSearchParams(location.hash.slice(1));
    if (f.get("k") && f.get("h") && f.get("r")) {
      const machine = f.get("m") ? dec.decode(unb64(f.get("m"))) : "";
      store.set({ relay: f.get("r"), room: f.get("h"), key: f.get("k"), code: f.get("c"), machine });
      history.replaceState(null, "", location.pathname);
    }
    return store.get();
  }

  const hkdf = async (ikm, salt, info) =>
    new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
      await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), 256));
  const dh = async (priv, pub) => new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, priv, 256));
  const x25519 = (raw) => subtle.importKey("raw", raw, { name: "X25519" }, true, []);
  const aes = (raw, use) => subtle.importKey("raw", raw, "AES-GCM", false, [use]);

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android";
    return "navegador";
  }

  // ---- the link: one handshake, then sealed records both ways
  let link = null;           // {send(obj)} once the daemon said it is ready
  let waiting = [];          // what the window asked before that
  let nextId = 1;
  const pending = new Map(); // request id -> resolve(answer)
  const sockets = new Map(); // socket id -> RemoteSocket
  let backoff = 1;
  let refused = false;       // the daemon does not know this phone: no point in trying again
  const WAIT = 20000;        // what a request waits for the link before failing like a fetch without network

  function note(text) {
    let el = document.getElementById("atril-remote-note");
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "atril-remote-note";
      el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:10px 14px;font:13px/1.4 ui-monospace,monospace;background:#1b1b1f;color:#e6e6ea;border-top:1px solid #333";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
  }

  async function connect() {
    const p = pairing();
    if (!p) { note("Este teléfono no está emparejado. En Atril, en tu computadora: Agregar dispositivo → Teléfono, y escaneá el código."); return; }
    note("Conectando con " + (p.machine || "tu computadora") + "…");
    const device = await deviceKey();
    const devicePub = new Uint8Array(await subtle.exportKey("raw", device.publicKey));
    const daemonPub = unb64(p.key);
    const eph = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    const ephPub = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
    const np = crypto.getRandomValues(new Uint8Array(16));
    const ws = new NativeWebSocket(p.relay + "/client/" + p.room);
    let kin = null, kout = null, nin = 0, nout = 0, ready = false;

    ws.onopen = () => ws.send(JSON.stringify({ v: 1, e: b64(ephPub), s: b64(devicePub), n: b64(np), c: p.code || null, name: deviceName() }));
    // one record at a time, in arrival order: each one opens with the next counter
    let inbound = Promise.resolve();
    ws.onmessage = (ev) => { inbound = inbound.then(() => receive(ev)); };
    const receive = async (ev) => {
      try {
        if (!kin) {
          const m = JSON.parse(ev.data);
          if (m.err) { refused = true; store.set({ ...p, code: null }); ws.close(); return; }
          const edPub = unb64(m.e), nd = unb64(m.n);
          const h = new Uint8Array(await subtle.digest("SHA-256", cat(enc.encode(PROTO), ephPub, devicePub, daemonPub, edPub, np, nd)));
          const ed = await x25519(edPub);
          const ck1 = await hkdf(await dh(eph.privateKey, await x25519(daemonPub)), h, "atril 1");
          const ck2 = await hkdf(await dh(device.privateKey, ed), ck1, "atril 2");
          const dh3 = await dh(eph.privateKey, ed);
          kin = await aes(await hkdf(dh3, ck2, "atril h2c"), "decrypt");
          kout = await aes(await hkdf(dh3, ck2, "atril c2h"), "encrypt");
          return;
        }
        const plain = await subtle.decrypt({ name: "AES-GCM", iv: nonce(nin), additionalData: enc.encode(PROTO) }, kin, unb64(ev.data));
        nin++;
        const msg = JSON.parse(dec.decode(plain));
        if (!ready) {
          if (msg.t !== "ready") throw new Error("unexpected first record");
          ready = true;
          backoff = 1;
          if (p.code) store.set({ ...p, code: null });   // paired: the code was used
          note("");
          let chain = Promise.resolve();
          link = {
            // records go out one at a time, in order: each one takes the next counter
            send(obj) {
              chain = chain.then(async () => {
                const ct = await subtle.encrypt({ name: "AES-GCM", iv: nonce(nout++), additionalData: enc.encode(PROTO) }, kout, enc.encode(JSON.stringify(obj)));
                ws.send(b64(ct));
              });
              return chain;
            },
          };
          const w = waiting; waiting = [];
          w.forEach((o) => link.send(o));
          return;
        }
        deliver(msg);
      } catch (e) {
        // a record that does not open is not ours to guess about: drop the connection
        ws.close();
      }
    };
    ws.onclose = () => {
      link = null;
      for (const s of sockets.values()) s._closed(1006);
      sockets.clear();
      for (const [id, done] of pending) done(null);
      pending.clear();
      if (refused) { note("Tu computadora no reconoce este teléfono (lo quitaron, o el código venció). Emparejalo de nuevo: en Atril, Agregar dispositivo → Teléfono."); return; }
      note("Sin conexión con " + (p.machine || "tu computadora") + ": reintentando…");
      setTimeout(connect, backoff * 1000);
      backoff = Math.min(backoff * 2, 30);
    };
  }

  function deliver(msg) {
    if (msg.t === "res") {
      const done = pending.get(msg.id);
      pending.delete(msg.id);
      if (done) done(msg);
    } else if (msg.t === "wso") sockets.get(msg.id)?._opened();
    else if (msg.t === "wsm") sockets.get(msg.id)?._message(msg.d);
    else if (msg.t === "wsc") { sockets.get(msg.id)?._closed(1000); sockets.delete(msg.id); }
    // the computer moved to another relay: it said so sealed, so it is the computer; the next connection goes there
    else if (msg.t === "relay" && /^wss?:\/\/[^\s?#]+$/.test(msg.relay || "")) { const p = pairing(); if (p) store.set({ ...p, relay: msg.relay }); }
  }

  function send(obj) {
    if (link) link.send(obj);
    else { waiting.push(obj); setTimeout(() => { waiting = waiting.filter((o) => o !== obj); }, WAIT); }
  }

  // ---- what the window calls
  const isApi = (url) => {
    const u = new URL(url, location.href);
    return u.host === location.host && u.pathname.startsWith("/api/") ? u.pathname + u.search : null;
  };

  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const path = isApi(url);
    if (!path) return nativeFetch(input, init);
    if (refused) throw new TypeError("Atril: this phone is not paired");
    const id = nextId++;
    const answer = new Promise((ok) => {
      pending.set(id, ok);
      setTimeout(() => { if (pending.delete(id)) ok(null); }, WAIT);
    });
    const body = init.body == null ? null : typeof init.body === "string" ? init.body : await new Response(init.body).text();
    send({ id, t: "req", m: (init.method || "GET").toUpperCase(), p: path, b: body });
    const a = await answer;
    if (!a) throw new TypeError("Atril: no connection with the computer");
    return new Response(a.s === 204 ? null : a.b, { status: a.s, headers: { "Content-Type": a.ct || "application/json" } });
  };

  class RemoteSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.binaryType = "blob";
      this.protocol = "";
      this.extensions = "";
      this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._id = nextId++;
      sockets.set(this._id, this);
      if (refused) { setTimeout(() => this._closed(1006)); return; }
      send({ id: this._id, t: "ws", p: isApi(url) });
      setTimeout(() => { if (this.readyState === 0) { sockets.delete(this._id); this._closed(1006); } }, WAIT);
    }
    _fire(type, ev) {
      if (typeof this["on" + type] === "function") this["on" + type](ev);
      this.dispatchEvent(ev);
    }
    _opened() { this.readyState = 1; this._fire("open", new Event("open")); }
    _message(d) { if (this.readyState === 1) this._fire("message", new MessageEvent("message", { data: d })); }
    _closed(code) {
      if (this.readyState === 3) return;
      const wasOpen = this.readyState === 1;
      this.readyState = 3;
      if (!wasOpen) this._fire("error", new Event("error"));
      this._fire("close", new CloseEvent("close", { code, wasClean: code === 1000 }));
    }
    send(d) {
      if (this.readyState !== 1) throw new DOMException("not open", "InvalidStateError");
      send({ id: this._id, t: "wsm", d: String(d) });
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      send({ id: this._id, t: "wsc" });
      sockets.delete(this._id);
      this._closed(1000);
    }
  }
  RemoteSocket.CONNECTING = 0; RemoteSocket.OPEN = 1; RemoteSocket.CLOSING = 2; RemoteSocket.CLOSED = 3;

  window.WebSocket = function (url, protocols) {
    return isApi(url) ? new RemoteSocket(url) : new NativeWebSocket(url, protocols);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  if (!window.isSecureContext || !crypto.subtle) {
    note("Atril necesita HTTPS en este teléfono.");
    return;
  }
  connect().catch((e) => note("No se pudo conectar: " + e.message));
})();
