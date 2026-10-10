// Atril UI: a sidebar of live sessions, tabs, and one xterm.js per open tab.
// Closing a tab only closes its socket: the session keeps running in the daemon.
"use strict";

const $ = (s) => document.querySelector(s);
const WS = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const sessions = new Map();   // id -> metadata from the daemon
const tabs = new Map();       // id -> {term, fit, ws, el, tab}
let active = null;
let machine = "";
let wanted = null;            // `atr open <session>`: the tab to show first

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---- login: `atr open` brings the key in the fragment; it becomes an HttpOnly cookie
async function login() {
  const m = location.hash.match(/t=([\w-]+)/);
  const want = location.hash.match(/s=([^&]+)/);
  if (want) wanted = decodeURIComponent(want[1]);
  const headers = m ? { Authorization: "Bearer " + m[1] } : {};
  if (m) history.replaceState(null, "", location.pathname);
  const r = await fetch("/api/login", { method: "POST", headers, credentials: "same-origin" });
  if (!r.ok) return false;
  machine = (await r.json()).machine;
  return true;
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}

// ---- sidebar
function statusOf(s) {
  if (s.status === "exited") return "exited";
  if (s.bell) return "bell";
  return s.activity || "idle";
}
const LABEL = { working: "trabajando", idle: "esperando", bell: "te necesita", exited: "terminó" };
// quiet means different things: an agent is waiting for you, a shell is just there
function label(s) {
  const st = statusOf(s);
  if (st === "idle" && s.kind === "shell") return "inactiva";
  if (st === "idle") return "esperándote";
  return LABEL[st];
}

function ago(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return Math.floor(d) + "s";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}

function renderSide() {
  $("#spaces").innerHTML = "";
  const li = document.createElement("li");
  li.className = "on";
  li.innerHTML = `<span class="st idle"></span><span></span>`;
  li.lastChild.textContent = machine || "this computer";
  $("#spaces").append(li);

  const list = [...sessions.values()];
  const agents = list.filter((s) => s.kind !== "shell");
  const shells = list.filter((s) => s.kind === "shell");
  $("#count").textContent = list.filter((s) => s.status === "running").length + " vivas";
  const ul = $("#agents");
  ul.innerHTML = "";
  for (const [title, group] of [["agentes", agents], ["terminales", shells]]) {
    if (!group.length) continue;
    const g = document.createElement("li");
    g.className = "group";
    g.textContent = title;
    ul.append(g);
    for (const s of group) ul.append(sessionItem(s));
  }
  renderTabs();
}

function sessionItem(s) {
  const li = document.createElement("li");
  const st = statusOf(s);
  li.className = tabs.has(s.id) ? "open" : "";
  li.title = `${s.cmd} ${(s.args || []).join(" ")}\npid ${s.pid} · ${s.id} · ${label(s)}`;
  li.innerHTML = `<span class="st ${st}"></span><span class="name"></span><span class="meta"></span><span class="sub"></span>`;
  li.querySelector(".name").textContent = s.name;
  li.querySelector(".meta").textContent = s.status === "exited" ? "exit " + (s.exit_code ?? "?") : ago(s.started);
  // a title that is only the program's path says nothing: show the state instead
  const title = s.title && !/[\\/].*\.(exe|cmd)$/i.test(s.title) && s.title !== s.cmd ? s.title : null;
  li.querySelector(".sub").textContent = title && s.status === "running" ? title : `${label(s)} · pid ${s.pid}`;
  li.onclick = () => { openTab(s.id); $("#side").classList.remove("show"); };
  li.oncontextmenu = (e) => { e.preventDefault(); showCtx(s.id, e.clientX, e.clientY); };
  let press;
  li.ontouchstart = (e) => { press = setTimeout(() => showCtx(s.id, e.touches[0].clientX, e.touches[0].clientY), 550); };
  li.ontouchend = li.ontouchmove = () => clearTimeout(press);
  return li;
}

function events() {
  const ws = new WebSocket(WS + "/api/events");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "show") { show(m.ref); return; }
    if (m.t === "all") { sessions.clear(); for (const s of m.sessions) sessions.set(s.id, s); }
    else if (m.session.status === "removed") sessions.delete(m.session.id);
    else sessions.set(m.session.id, m.session);
    renderSide();
  };
  ws.onclose = () => setTimeout(events, 1500);
}
setInterval(renderSide, 30000);   // keep the "ago" column honest

// `atr open [session]` while this window is open: show it here
function show(ref) {
  window.focus();
  if (!ref) return;
  const s = [...sessions.values()].reverse().find((x) => [x.id, x.name, String(x.pid)].includes(ref));
  if (s) openTab(s.id);
}

// ---- tabs
function renderTabs() {
  const bar = $("#tablist");
  bar.innerHTML = "";
  for (const [id, t] of tabs) {
    const s = sessions.get(id) || { name: id };
    const el = document.createElement("div");
    el.className = "tab" + (id === active ? " on" : "");
    el.innerHTML = `<span class="st ${statusOf(s)}"></span><span class="t"></span><button class="x" title="Cerrar pestaña (el programa sigue)">×</button>`;
    el.querySelector(".t").textContent = s.name;
    el.onclick = (e) => { if (!e.target.classList.contains("x")) focusTab(id); };
    el.querySelector(".x").onclick = () => closeTab(id);
    el.onauxclick = (e) => { if (e.button === 1) closeTab(id); };
    bar.append(el);
  }
  $("#empty").hidden = tabs.size > 0;
  store.set("tabs", [...tabs.keys()]);
}

function openTab(id) {
  if (tabs.has(id)) return focusTab(id);
  const el = document.createElement("div");
  el.className = "term";
  $("#stage").append(el);
  const term = new Terminal({
    fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"),
    fontSize: 14, cursorBlink: true, allowProposedApi: true, scrollback: 10000,
    theme: { background: "#0c0c0d", foreground: "#e6e6ea", cursor: "#e6e6ea", selectionBackground: "#2a2d45" },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.attachCustomKeyEventHandler(shortcuts);
  const t = { term, fit, el, ws: null, ctrl: false };
  tabs.set(id, t);
  connect(id, t);
  term.onData((d) => {
    if (t.ended) return;
    if (t.ctrl && d.length === 1) { d = String.fromCharCode(d.toUpperCase().charCodeAt(0) & 31); setCtrl(t, false); }
    send(t, { t: "i", d });
  });
  term.onResize(({ cols, rows }) => send(t, { t: "r", cols, rows }));
  // only a key you pressed (onData also carries the terminal's own answers to queries)
  term.onKey(() => {
    if (t.ended && !t.warned) {
      t.warned = true;
      t.term.write("\r\n\x1b[33mEste programa ya terminó: lo que escribas no llega a ningún lado. Usá «Reiniciar».\x1b[0m\r\n");
    }
  });
  focusTab(id);
}

function connect(id, t) {
  const ws = new WebSocket(WS + "/api/sessions/" + encodeURIComponent(id) + "/attach");
  t.ws = ws;
  ws.onopen = () => { t.fit.fit(); send(t, { t: "r", cols: t.term.cols, rows: t.term.rows }); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "o") t.term.write(m.d);
    else if (m.t === "exit") {
      if (t.ended) return;
      t.ended = true;
      const s = sessions.get(id) || {};
      t.term.write(`\r\n\x1b[2m── ${s.name || id} terminó (código ${m.code ?? "?"}) ──\x1b[0m\r\n`);
      const end = document.createElement("div");
      end.className = "ended";
      end.innerHTML = `<span></span><button>Reiniciar</button>`;
      end.firstChild.textContent = `terminó · código ${m.code ?? "?"}`;
      end.lastChild.onclick = () => restart(id);
      t.el.append(end);
      renderSide();
    } else if (m.t === "error") closeTab(id);   // a tab remembered from a session that is gone
  };
  ws.onclose = () => {
    // the daemon or the network went away; the session may still be alive: try again
    if (tabs.get(id) === t && !t.closing) setTimeout(() => { if (tabs.get(id) === t) { t.term.reset(); connect(id, t); } }, 2000);
  };
}

function send(t, m) { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify(m)); }

function focusTab(id) {
  active = id;
  for (const [k, t] of tabs) t.el.hidden = k !== id;
  const t = tabs.get(id);
  if (t) { requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); }); }
  renderSide();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.closing = true;
  t.ws && t.ws.close();
  t.term.dispose();
  t.el.remove();
  tabs.delete(id);
  if (active === id) active = [...tabs.keys()].pop() || null;
  if (active) focusTab(active); else renderSide();
}

// the same program again, in the same folder and with the same name
async function restart(id) {
  const s = sessions.get(id);
  if (!s) return;
  closeTab(id);
  await api("DELETE", `/api/sessions/${id}`);
  sessions.delete(id);
  await newTab({ cmd: s.cmd, args: s.args, cwd: s.cwd, name: s.name });
}

async function newTab(body = {}) {
  const t = active && tabs.get(active);
  const s = await api("POST", "/api/sessions", { cols: t ? t.term.cols : 120, rows: t ? t.term.rows : 32, ...body });
  sessions.set(s.id, s);
  openTab(s.id);
}

window.addEventListener("resize", () => { const t = tabs.get(active); if (t) t.fit.fit(); });

// ---- palette: find any session by name, command, title, pid or id
function openPalette() {
  $("#palette").hidden = false;
  $("#q").value = "";
  paint();
  $("#q").focus();
}
let sel = 0;
function matches() {
  const q = $("#q").value.toLowerCase().trim();
  return [...sessions.values()].filter((s) =>
    !q || [s.name, s.cmd, s.title, String(s.pid), s.id, s.kind].some((v) => v && String(v).toLowerCase().includes(q)));
}
function paint() {
  const ul = $("#results");
  ul.innerHTML = "";
  const list = matches();
  sel = Math.min(sel, Math.max(0, list.length - 1));
  list.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = i === sel ? "sel" : "";
    li.innerHTML = `<span class="st ${statusOf(s)}"></span><span></span><span class="meta"></span>`;
    li.children[1].textContent = s.name;
    li.children[2].textContent = `${s.cmd} · pid ${s.pid} · ${s.id}`;
    li.onclick = () => pick(s.id);
    ul.append(li);
  });
}
function pick(id) { $("#palette").hidden = true; openTab(id); }
$("#q").oninput = () => { sel = 0; paint(); };
$("#q").onkeydown = (e) => {
  const list = matches();
  if (e.key === "ArrowDown") { sel = Math.min(sel + 1, list.length - 1); paint(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
  else if (e.key === "Enter" && list[sel]) pick(list[sel].id);
  else if (e.key === "Escape") $("#palette").hidden = true;
};
$("#palette").onclick = (e) => { if (e.target.id === "palette") $("#palette").hidden = true; };

// ---- context menu
let ctxId = null;
function showCtx(id, x, y) {
  ctxId = id;
  const m = $("#ctx");
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - 180) + "px";
  m.style.top = Math.min(y, innerHeight - 120) + "px";
  const s = sessions.get(id);
  m.querySelector('[data-a="kill"]').hidden = s.status !== "running";
  m.querySelector('[data-a="remove"]').hidden = s.status === "running";
  m.querySelector('[data-a="restart"]').hidden = s.status === "running";
}
document.addEventListener("click", (e) => { if (!e.target.closest("#ctx")) $("#ctx").hidden = true; });
$("#ctx").onclick = async (e) => {
  const a = e.target.dataset.a;
  if (!a) return;
  $("#ctx").hidden = true;
  const s = sessions.get(ctxId);
  if (a === "open") openTab(ctxId);
  if (a === "kill" && confirm(`¿Matar ${s.name} (pid ${s.pid})? El programa se cierra.`)) await api("POST", `/api/sessions/${ctxId}/kill`);
  if (a === "restart") await restart(ctxId);
  if (a === "remove") { closeTab(ctxId); await api("DELETE", `/api/sessions/${ctxId}`); }
};

// ---- keys
function shortcuts(e) {
  if (e.type !== "keydown") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyK") { openPalette(); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyT") { newTab(); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") { if (active) closeTab(active); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") { setSide($("#side").classList.contains("collapsed")); return false; }
  if (e.ctrlKey && e.code === "Tab") {
    const ids = [...tabs.keys()];
    if (ids.length) focusTab(ids[(ids.indexOf(active) + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
    return false;
  }
  return true;
}
document.addEventListener("keydown", (e) => { if (!shortcuts(e)) e.preventDefault(); });

const KEYS = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", ctrlc: "\x03" };
function setCtrl(t, on) { t.ctrl = on; $('#keys [data-k="ctrl"]').classList.toggle("on", on); }
$("#keys").onclick = (e) => {
  const k = e.target.dataset.k;
  const t = tabs.get(active);
  if (!k || !t) return;
  if (k === "ctrl") setCtrl(t, !t.ctrl); else send(t, { t: "i", d: KEYS[k] });
  t.term.focus();
};

$("#new").onclick = $("#plus").onclick = () => newTab();
$("#find").onclick = openPalette;
function setSide(open) {
  $("#side").classList.toggle("collapsed", !open);
  $("#expand").hidden = open;
  store.set("side", open);
  requestAnimationFrame(() => { const t = tabs.get(active); if (t) t.fit.fit(); });
}
$("#collapse").onclick = () => setSide(false);
$("#expand").onclick = () => setSide(true);
setSide(store.get("side", true));
$("#menu").onclick = () => $("#side").classList.toggle("show");
$("#stage").onclick = () => $("#side").classList.remove("show");

// ---- start
(async () => {
  if (!(await login())) {
    document.body.innerHTML = `<p style="padding:40px;color:#9a9aa2">Abrí Atril con <b style="color:#e6e6ea">atr open</b>: trae la llave de esta computadora.</p>`;
    return;
  }
  document.title = "Atril · " + machine;
  events();
  for (const id of store.get("tabs", [])) openTab(id);
  if (wanted) {
    const { items } = await api("GET", "/api/sessions");
    const s = items.find((x) => [x.id, x.name, String(x.pid)].includes(wanted));
    if (s) openTab(s.id);
  }
})();
