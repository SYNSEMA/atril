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
  // what this side saw (a connection that ended, and how): kept until the computer gets it
  function plog(ev) {
    try {
      const a = JSON.parse(localStorage.getItem("atril.log") || "[]");
      a.push({ at: Math.round(Date.now() / 1000), hidden: document.hidden, online: navigator.onLine, ...ev });
      localStorage.setItem("atril.log", JSON.stringify(a.slice(-50)));
    } catch {}
  }
  function takeLog() {
    try { const a = JSON.parse(localStorage.getItem("atril.log") || "[]"); localStorage.removeItem("atril.log"); return a; } catch { return []; }
  }

  let link = null;           // {send(obj)} once the daemon said it is ready
  let waiting = [];          // what the window asked before that
  let nextId = 1;
  const pending = new Map(); // request id -> resolve(answer)
  const sockets = new Map(); // socket id -> RemoteSocket
  let backoff = 1;
  let refused = false;       // the daemon does not know this phone: no point in trying again
  const WAIT = 20000;        // what a request waits for the link before failing like a fetch without network

  // a line at the bottom of the window; in the app it can carry a button (Escanear código)
  function note(text, action) {
    let el = document.getElementById("atril-remote-note");
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "atril-remote-note";
      el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:10px 14px;font:13px/1.4 ui-monospace,monospace;background:#1b1b1f;color:#e6e6ea;border-top:1px solid #333;display:flex;gap:12px;align-items:center;padding-bottom:calc(10px + var(--sab, 0px))";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = "";
    const t = document.createElement("span");
    t.style.flex = "1";
    t.textContent = text;
    el.append(t);
    if (action) {
      const b = document.createElement("button");
      b.textContent = action.label;
      b.style.cssText = "flex:none;padding:8px 14px;border:0;border-radius:4px;background:#8fb4ff;color:#0b0b10;font:700 13px ui-monospace,monospace";
      b.onclick = action.run;
      el.append(b);
    }
  }

  // ---- the Android app: the same page inside it, plus a way in for the pairing link
  const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const plugin = (name) => (native && window.Capacitor.Plugins ? window.Capacitor.Plugins[name] : null);
  const scanAction = native ? { label: "Escanear código", run: () => scan() } : null;
  const HOW = native
    ? "En Atril, en tu computadora: Agregar dispositivo → Teléfono; después tocá Escanear código."
    : "En Atril, en tu computadora: Agregar dispositivo → Teléfono, y escaneá el código.";

  // a pairing link (what the QR holds) → this page with it in the fragment, once
  function adopt(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    const f = new URLSearchParams(u.hash.slice(1));
    if (!f.get("k") || !f.get("h") || !f.get("r")) return false;
    try { if (localStorage.getItem("atril.adopted") === u.hash) return true; localStorage.setItem("atril.adopted", u.hash); } catch {}
    history.replaceState(null, "", location.pathname + u.hash);
    location.reload();
    return true;
  }
  async function scan() {
    const S = plugin("BarcodeScanner");
    if (!S) return;
    try {
      const has = await S.isGoogleBarcodeScannerModuleAvailable();
      if (!has.available) {
        note("Preparando el lector de códigos (una sola vez)…");
        await S.installGoogleBarcodeScannerModule();
        for (let i = 0; i < 90 && !(await S.isGoogleBarcodeScannerModuleAvailable()).available; i++) await new Promise((r) => setTimeout(r, 1000));
      }
      const { barcodes } = await S.scan({ formats: ["QR_CODE"] });
      const raw = barcodes && barcodes[0] && barcodes[0].rawValue;
      if (raw && !adopt(raw)) note("Ese código no es de Atril. " + HOW, scanAction);
    } catch (e) {
      note("No se pudo escanear: " + (e && e.message ? e.message : e), scanAction);
    }
  }
  if (native) {
    // the status bar's icons light on a dark theme, dark on a light one (the theme can change any time)
    const Bars = plugin("SystemBars");
    let barStyle = "";
    const paintBars = () => {
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(bg);
      if (!m || !Bars) return;
      const lum = 0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16);
      const style = lum < 128 ? "DARK" : "LIGHT";
      if (style !== barStyle) { barStyle = style; Bars.setStyle({ style }).catch(() => {}); }
    };
    new MutationObserver(paintBars).observe(document.documentElement, { attributes: true });
    window.addEventListener("load", paintBars);
    const App = plugin("App");
    if (App) {
      App.addListener("appUrlOpen", (e) => adopt(e.url));
      App.getLaunchUrl().then((r) => { if (r && r.url) adopt(r.url); }).catch(() => {});
    }
  }

  async function connect() {
    const p = pairing();
    if (!p) { note("Este teléfono no está emparejado. " + HOW, scanAction); return; }
    note("Conectando con " + (p.machine || "tu computadora") + "…");
    const device = await deviceKey();
    const devicePub = new Uint8Array(await subtle.exportKey("raw", device.publicKey));
    const daemonPub = unb64(p.key);
    const eph = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    const ephPub = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
    const np = crypto.getRandomValues(new Uint8Array(16));
    const ws = new NativeWebSocket(p.relay + "/client/" + p.room);
    let kin = null, kout = null, nin = 0, nout = 0, ready = false;

    let alive = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, e: b64(ephPub), s: b64(devicePub), n: b64(np), c: p.code || null, name: deviceName() }));
      // a quiet line still talks: the relay, and the mobile network on the way, close a silent one
      alive = setInterval(() => { if (ws.readyState === 1) ws.send("~"); }, 25000);
    };
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
          const seen = takeLog();
          if (seen.length) link.send({ t: "log", items: seen });
          return;
        }
        // the window's own handlers run outside: an error of theirs is not a broken record, and must not
        // end the connection (it is noted, for the computer's log)
        try { deliver(msg); } catch (err) { plog({ ev: "window error", t: msg.t, err: String(err && err.message || err).slice(0, 160) }); }
      } catch (e) {
        // a record that does not open is not ours to guess about: drop the connection
        plog({ ev: "bad record", err: String(e && e.message || e).slice(0, 120), nin });
        ws.close();
      }
    };
    const opened = Date.now();
    ws.onclose = (e) => {
      plog({ ev: "closed", code: e.code, reason: (e.reason || "").slice(0, 80), was_ready: ready, lasted: Math.round((Date.now() - opened) / 1000) });
      clearInterval(alive);
      link = null;
      for (const s of sockets.values()) s._closed(1006);
      sockets.clear();
      for (const [id, done] of pending) done(null);
      pending.clear();
      if (refused) { note("Tu computadora no reconoce este teléfono (lo quitaron, o el código venció). Emparejalo de nuevo. " + HOW, scanAction); return; }
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
