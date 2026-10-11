// Atril UI. A space is a folder (with its git branch); its tabs are the sessions that run in it.
// The agents list shows only agents, from every space. Closing a tab only hides it and closes its
// socket: the program keeps running in the daemon, and agents / find bring it back.
"use strict";

const $ = (s) => document.querySelector(s);
const WS = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const sessions = new Map();   // id -> metadata from the daemon
let spaces = [];              // [{key, path, name, branch}]
const terms = new Map();      // id -> {term, fit, ws, el, ...} for tabs that were shown
let machine = "";
let wanted = null;            // `atr open <session>`: the tab to show first

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let current = store.get("space", null);                 // the space on screen
const hidden = new Set(store.get("hidden", []));        // tabs closed in this window
const lastTab = store.get("lastTab", {});               // space -> the tab it showed last

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
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

// ---- what a session is doing
function statusOf(s) {
  if (s.status === "exited") return "exited";
  if (s.bell) return "bell";
  return s.activity || "idle";
}
const isAgent = (s) => s.kind !== "shell";
function label(s) {
  const st = statusOf(s);
  if (st === "exited") return "terminó";
  if (st === "bell") return "te necesita";
  if (st === "working") return "trabajando";
  return isAgent(s) ? "esperándote" : "inactiva";
}
const inSpace = (key) => [...sessions.values()].filter((s) => s.space === key).sort((a, b) => a.started - b.started);
const spaceOf = (key) => spaces.find((sp) => sp.key === key);

// what runs now and where, first; the program the session started with last
function tooltip(s) {
  const what = isAgent(s) ? s.kind : "terminal";
  const started = `${s.cmd} ${(s.args || []).join(" ")}`.trim();
  return `${s.name} — ${what}, ${label(s)}\n${s.here || s.cwd}\npid ${s.pid} · ${s.id} · empezó con: ${started}`;
}

// a tab's name: what you called it, else the agent, else its number in the space
function tabName(s, i) {
  const auto = /^[a-z-]+-\d+$/.test(s.name);
  if (!auto) return s.name;
  return isAgent(s) ? s.kind : String(i + 1);
}

// ---- sidebar
function renderSide() {
  $("#machine").textContent = machine ? "· " + machine : "";
  const ul = $("#spaces");
  ul.innerHTML = "";
  for (const sp of spaces) {
    const list = inSpace(sp.key);
    const li = document.createElement("li");
    li.className = sp.key === current ? "on" : "";
    li.title = sp.path;
    const needs = list.some((s) => s.status === "running" && isAgent(s) && statusOf(s) !== "working");
    const busy = list.some((s) => s.status === "running" && statusOf(s) === "working");
    li.innerHTML = `<span class="st ${needs ? "bell" : busy ? "working" : list.some((s) => s.status === "running") ? "idle" : "exited"}"></span><span class="name"></span><span class="meta"></span><span class="branch"></span>`;
    li.querySelector(".name").textContent = sp.name;
    li.querySelector(".meta").textContent = list.filter((s) => s.status === "running").length || "";
    li.querySelector(".branch").textContent = sp.branch || "";
    li.onclick = () => { selectSpace(sp.key); $("#side").classList.remove("show"); };
    li.oncontextmenu = (e) => { e.preventDefault(); showSpaceMenu(sp, e.clientX, e.clientY); };
    ul.append(li);
  }

  const agents = [...sessions.values()].filter(isAgent);
  $("#count").textContent = agents.length ? `${agents.filter((s) => s.status === "running").length} vivos` : "";
  const al = $("#agents");
  al.innerHTML = "";
  if (!agents.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "ninguno todavía: corré claude, codex… en una pestaña";
    al.append(li);
  }
  for (const sp of spaces) {
    const group = agents.filter((s) => s.space === sp.key);
    if (!group.length) continue;
    const g = document.createElement("li");
    g.className = "group";
    g.textContent = sp.name + (sp.branch ? " · " + sp.branch : "");
    al.append(g);
    for (const s of group) al.append(agentItem(s));
  }
  renderTabs();
}

function agentItem(s) {
  const li = document.createElement("li");
  const st = statusOf(s);
  li.className = s.id === lastTab[current] && s.space === current ? "open" : "";
  li.title = tooltip(s);
  li.innerHTML = `<span class="st ${st === "idle" ? "bell" : st}"></span><span class="name"></span><span class="meta"></span><span class="sub"></span>`;
  li.querySelector(".name").textContent = /^[a-z-]+-\d+$/.test(s.name) ? s.kind : s.name;   // untitled: the agent's name
  li.querySelector(".meta").textContent = s.status === "exited" ? "exit " + (s.exit_code ?? "?") : ago(s.started);
  const title = s.title && s.status === "running" && !/[\\/].*\.(exe|cmd)$/i.test(s.title) ? s.title : null;
  li.querySelector(".sub").textContent = `${label(s)}${title ? " · " + title : ""}`;
  li.onclick = () => { reveal(s.id); $("#side").classList.remove("show"); };
  li.oncontextmenu = (e) => { e.preventDefault(); showCtx(s.id, e.clientX, e.clientY); };
  let press;
  li.ontouchstart = (e) => { press = setTimeout(() => showCtx(s.id, e.touches[0].clientX, e.touches[0].clientY), 550); };
  li.ontouchend = li.ontouchmove = () => clearTimeout(press);
  return li;
}

function ago(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return Math.floor(d) + "s";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}

function events() {
  const ws = new WebSocket(WS + "/api/events");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "show") return show(m.ref);
    if (m.t === "spaces") spaces = m.spaces;
    else if (m.t === "all") {
      sessions.clear();
      for (const s of m.sessions) sessions.set(s.id, s);
      spaces = m.spaces;
      if (!spaceOf(current)) current = spaces.length ? spaces[0].key : null;
    } else if (m.session.status === "removed") { sessions.delete(m.session.id); dropTerm(m.session.id); }
    else sessions.set(m.session.id, m.session);
    renderSide();
  };
  ws.onclose = () => setTimeout(events, 1500);
}
// the branch can change under us (git checkout in a tab): look again now and then
setInterval(async () => { try { spaces = (await api("GET", "/api/spaces")).items; renderSide(); } catch {} }, 15000);

// ---- spaces and tabs
function selectSpace(key) {
  current = key;
  store.set("space", key);
  const visible = tabsOf(key);
  const want = visible.find((s) => s.id === lastTab[key]) || visible[visible.length - 1];
  if (want) focusTab(want.id); else { showOnly(null); renderSide(); }
}

const tabsOf = (key) => inSpace(key).filter((s) => !hidden.has(s.id));

let editing = false;          // a tab title being typed: the bar must not be redrawn under it
function renderTabs() {
  if (editing) return;
  const bar = $("#tablist");
  bar.innerHTML = "";
  const list = tabsOf(current);
  list.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (s.id === lastTab[current] ? " on" : "");
    el.dataset.id = s.id;
    el.ondblclick = (e) => { if (e.target !== el.querySelector(".x")) renameTab(s.id); };
    const st = statusOf(s);
    el.innerHTML = `<span class="st ${st === "idle" && isAgent(s) ? "bell" : st}"></span><span class="t"></span><button class="x"></button>`;
    el.querySelector(".t").textContent = tabName(s, i);
    const x = el.querySelector(".x");
    x.textContent = "×";
    x.title = s.status === "running" ? "Cerrar pestaña (el programa sigue: está en agents / find)" : "Cerrar y olvidar";
    el.title = tooltip(s) + "\n(doble clic para ponerle título)";
    el.onclick = (e) => { if (e.target !== x && e.target.tagName !== "INPUT") focusTab(s.id); };
    x.onclick = () => closeTab(s.id);
    el.onauxclick = (e) => { if (e.button === 1) closeTab(s.id); };
    el.oncontextmenu = (e) => { e.preventDefault(); showCtx(s.id, e.clientX, e.clientY); };
    bar.append(el);
  });
  const sp = spaceOf(current);
  $("#empty").hidden = list.length > 0;
  $("#empty-title").textContent = sp ? `${sp.name} no tiene terminales abiertas.` : "Creá un space con new.";
  document.title = "Atril · " + (sp ? sp.name : machine);
}

// show a session wherever it is: its space, its tab
function reveal(id) {
  const s = sessions.get(id);
  if (!s) return;
  hidden.delete(id);
  store.set("hidden", [...hidden]);
  current = s.space;
  store.set("space", current);
  focusTab(id);
}

function focusTab(id) {
  const s = sessions.get(id);
  if (!s) return;
  lastTab[s.space] = id;
  store.set("lastTab", lastTab);
  const t = terms.get(id) || makeTerm(id);
  showOnly(id);
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
  renderSide();
}

function showOnly(id) { for (const [k, t] of terms) t.el.hidden = k !== id; }

function closeTab(id) {
  const s = sessions.get(id);
  dropTerm(id);
  if (s && s.status !== "running") {
    api("DELETE", `/api/sessions/${id}`).catch(() => {});   // ended: nothing to keep
  } else {
    hidden.add(id);
    store.set("hidden", [...hidden]);
  }
  if (lastTab[current] === id) delete lastTab[current];
  const rest = tabsOf(current).filter((x) => x.id !== id);
  if (rest.length) focusTab(rest[rest.length - 1].id); else { showOnly(null); renderSide(); }
}

function dropTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  t.closing = true;
  t.ws && t.ws.close();
  t.term.dispose();
  t.el.remove();
  terms.delete(id);
}

async function newTab(body = {}) {
  const sp = spaceOf(current);
  const t = terms.get(lastTab[current]);
  const s = await api("POST", "/api/sessions", {
    cols: t ? t.term.cols : 120, rows: t ? t.term.rows : 32,
    cwd: sp ? sp.path : undefined, ...body,
  });
  sessions.set(s.id, s);
  reveal(s.id);
}

// ---- titles: + asks for one (Enter alone keeps the number); a double click on a tab changes it
function askTitle() {
  const box = $("#newtitle");
  box.value = "";
  box.hidden = false;
  $("#plus").hidden = true;
  box.focus();
}
function endAsk() { $("#newtitle").hidden = true; $("#plus").hidden = false; }
$("#newtitle").onkeydown = (e) => {
  if (e.key === "Enter") { const name = e.target.value.trim(); endAsk(); newTab(name ? { name } : {}).catch((err) => alert(err.message)); }
  else if (e.key === "Escape") { endAsk(); const t = terms.get(lastTab[current]); if (t) t.term.focus(); }
};
$("#newtitle").onblur = endAsk;

function renameTab(id) {
  const el = document.querySelector(`.tab[data-id="${id}"] .t`);
  const s = sessions.get(id);
  if (!el || !s) return;
  const input = document.createElement("input");
  input.value = /^[a-z-]+-\d+$/.test(s.name) ? "" : s.name;
  input.placeholder = "título";
  input.maxLength = 80;
  el.replaceWith(input);
  input.focus();
  editing = true;
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    editing = false;
    const name = input.value.trim();
    if (save && name && name !== s.name) {
      try { await api("POST", `/api/sessions/${id}/rename`, { name }); } catch (err) { alert(err.message); }
    }
    renderTabs();
    const t = terms.get(id);
    if (t) t.term.focus();
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); e.stopPropagation(); };
  input.onblur = () => finish(true);
}

// ---- new space: recent repositories first, then browse any folder
const picker = { mode: "suggest", path: null, parent: null, branch: null, items: [], sel: 0 };
const pathLike = (v) => /[\\/:]/.test(v);

async function openPicker() {
  $("#picker").hidden = false;
  $("#pq").value = "";
  $("#pmsg").textContent = "";
  picker.sel = 0;
  $("#pq").focus();
  try {
    const r = await api("GET", "/api/dirs/suggest");
    picker.mode = "suggest";
    picker.path = r.home;
    picker.items = r.repos.map((x) => ({ ...x, kind: "repo" }));
    picker.items.push({ kind: "browse", name: "Explorar carpetas…", path: r.home });
    paintPicker();
  } catch (e) { $("#pmsg").textContent = e.message; }
}
function closePicker() { $("#picker").hidden = true; const t = terms.get(lastTab[current]); if (t) t.term.focus(); }

async function pickerGo(path) {
  try {
    const r = await api("GET", "/api/dirs?path=" + encodeURIComponent(path));
    Object.assign(picker, { mode: "browse", path: r.path, parent: r.parent, branch: r.branch, sel: 0 });
    picker.items = (r.parent ? [{ kind: "up", name: "..", path: r.parent }] : []).concat(r.dirs.map((x) => ({ ...x, kind: x.branch ? "repo" : "dir" })));
    $("#pq").value = "";
    $("#pmsg").textContent = "";
    paintPicker();
    $("#pq").focus();
  } catch (e) { $("#pmsg").textContent = e.message; }
}

function pickerVisible() {
  const q = $("#pq").value.trim().toLowerCase();
  if (!q || pathLike(q)) return picker.items;
  return picker.items.filter((x) => x.kind === "browse" || x.name.toLowerCase().includes(q));
}

function paintPicker() {
  const crumb = $("#pcrumb");
  if (picker.mode === "suggest") crumb.textContent = "Repos recientes · o explorá cualquier carpeta";
  else {
    crumb.textContent = picker.path;
    if (picker.branch) { const b = document.createElement("span"); b.className = "branch"; b.textContent = "  ⎇ " + picker.branch; crumb.append(b); }
  }
  const ok = $("#pok");
  ok.hidden = picker.mode !== "browse";
  ok.textContent = "Abrir " + ((picker.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "acá");
  const ul = $("#plist");
  ul.innerHTML = "";
  const list = pickerVisible();
  picker.sel = Math.min(picker.sel, Math.max(0, list.length - 1));
  list.forEach((x, i) => {
    const li = document.createElement("li");
    li.className = (i === picker.sel ? "sel " : "") + x.kind;
    const icon = { repo: "⎇", dir: "▸", up: "↑", browse: "…" }[x.kind];
    li.innerHTML = `<span class="ic"></span><span class="nm"></span><span class="br"></span>`;
    li.children[0].textContent = icon;
    li.children[1].textContent = x.name;
    li.children[2].textContent = x.branch || "";
    if (picker.mode === "suggest" && x.kind === "repo") {
      const pa = document.createElement("span");
      pa.className = "pa";
      pa.textContent = x.path;
      li.append(pa);
    }
    if (picker.mode === "browse" && x.kind === "repo") {
      const go = document.createElement("button");
      go.className = "go";
      go.textContent = "abrir";
      go.title = "Abrir este proyecto como space";
      go.onclick = (e) => { e.stopPropagation(); choose(x.path); };
      li.children[2].append(go);
    }
    li.onclick = () => { picker.sel = i; activate(x); };
    ul.append(li);
  });
  const cur = ul.children[picker.sel];
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

// a repository from the suggestions opens; a folder while browsing is entered
function activate(x) {
  if (!x) return;
  if (picker.mode === "suggest" && x.kind === "repo") choose(x.path);
  else pickerGo(x.path);
}

async function choose(path) {
  try {
    const { key } = await api("POST", "/api/spaces", { path });
    $("#picker").hidden = true;
    current = key;
    store.set("space", key);
    await newTab({ cwd: path });
  } catch (e) { $("#pmsg").textContent = e.message; }
}

$("#pq").oninput = () => { picker.sel = 0; paintPicker(); };
$("#pq").onkeydown = (e) => {
  const list = pickerVisible();
  const v = $("#pq").value.trim();
  if (e.key === "ArrowDown") { picker.sel = Math.min(picker.sel + 1, list.length - 1); paintPicker(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { picker.sel = Math.max(picker.sel - 1, 0); paintPicker(); e.preventDefault(); }
  else if (e.key === "Enter" && e.ctrlKey && picker.mode === "browse") choose(picker.path);
  else if (e.key === "Enter" && pathLike(v)) pickerGo(v);
  else if (e.key === "Enter") activate(list[picker.sel]);
  else if (e.key === "Backspace" && !v && picker.mode === "browse" && picker.parent) { pickerGo(picker.parent); e.preventDefault(); }
  else if (e.key === "Escape") closePicker();
};
$("#pok").onclick = () => choose(picker.path);
$("#pcancel").onclick = closePicker;
$("#picker").onclick = (e) => { if (e.target.id === "picker") closePicker(); };

// the same program again, in the same folder and with the same name
async function restart(id) {
  const s = sessions.get(id);
  if (!s) return;
  dropTerm(id);
  await api("DELETE", `/api/sessions/${id}`);
  sessions.delete(id);
  current = s.space;
  await newTab({ cmd: s.cmd, args: s.args, cwd: s.cwd, name: s.name });
}

// `atr open [session]` while this window is open: show it here
function show(ref) {
  window.focus();
  if (!ref) return;
  const s = [...sessions.values()].reverse().find((x) => [x.id, x.name, String(x.pid)].includes(ref));
  if (s) reveal(s.id);
}

// ---- one terminal per tab that was shown
function makeTerm(id) {
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
  terms.set(id, t);
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
  return t;
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
    } else if (m.t === "error") closeTab(id);   // a session that is gone
  };
  ws.onclose = () => {
    // the daemon or the network went away; the session may still be alive: try again
    if (terms.get(id) === t && !t.closing) setTimeout(() => { if (terms.get(id) === t) { t.term.reset(); connect(id, t); } }, 2000);
  };
}

function send(t, m) { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify(m)); }

window.addEventListener("resize", () => { const t = terms.get(lastTab[current]); if (t) t.fit.fit(); });

// ---- palette: any session of any space, by name, command, title, folder, pid or id
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
    !q || [s.name, s.cmd, s.title, s.cwd, String(s.pid), s.id, s.kind].some((v) => v && String(v).toLowerCase().includes(q)));
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
    li.children[2].textContent = `${(spaceOf(s.space) || {}).name || s.cwd} · ${s.cmd} · pid ${s.pid}`;
    li.onclick = () => pick(s.id);
    ul.append(li);
  });
}
function pick(id) { $("#palette").hidden = true; reveal(id); }
$("#q").oninput = () => { sel = 0; paint(); };
$("#q").onkeydown = (e) => {
  const list = matches();
  if (e.key === "ArrowDown") { sel = Math.min(sel + 1, list.length - 1); paint(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
  else if (e.key === "Enter" && list[sel]) pick(list[sel].id);
  else if (e.key === "Escape") $("#palette").hidden = true;
};
$("#palette").onclick = (e) => { if (e.target.id === "palette") $("#palette").hidden = true; };

// ---- context menus
let ctxId = null;
let ctxSpace = null;
function place(m, x, y) {
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - 190) + "px";
  m.style.top = Math.min(y, innerHeight - 140) + "px";
}
function showCtx(id, x, y) {
  ctxId = id;
  ctxSpace = null;
  const m = $("#ctx");
  const s = sessions.get(id);
  for (const b of m.querySelectorAll("button")) b.hidden = b.dataset.for === "space";
  m.querySelector('[data-a="kill"]').hidden = s.status !== "running";
  m.querySelector('[data-a="remove"]').hidden = s.status === "running";
  m.querySelector('[data-a="restart"]').hidden = s.status === "running";
  place(m, x, y);
}
function showSpaceMenu(sp, x, y) {
  ctxSpace = sp;
  const m = $("#ctx");
  for (const b of m.querySelectorAll("button")) b.hidden = b.dataset.for !== "space";
  place(m, x, y);
}
document.addEventListener("click", (e) => { if (!e.target.closest("#ctx")) $("#ctx").hidden = true; });
$("#ctx").onclick = async (e) => {
  const a = e.target.dataset.a;
  if (!a) return;
  $("#ctx").hidden = true;
  try {
    if (a === "forget") {
      await api("POST", "/api/spaces/forget", { key: ctxSpace.key });
      if (current === ctxSpace.key) current = null;
      return;
    }
    if (a === "newtab") { current = ctxSpace.key; store.set("space", current); renderSide(); return askTitle(); }
    const s = sessions.get(ctxId);
    if (a === "open") reveal(ctxId);
    if (a === "rename") { reveal(ctxId); setTimeout(() => renameTab(ctxId), 50); }
    if (a === "kill" && confirm(`¿Matar ${s.name} (pid ${s.pid})? El programa se cierra.`)) await api("POST", `/api/sessions/${ctxId}/kill`);
    if (a === "restart") await restart(ctxId);
    if (a === "remove") closeTab(ctxId);
  } catch (err) { alert(err.message); }
};

// ---- keys
function shortcuts(e) {
  if (e.type !== "keydown") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyK") { openPalette(); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyT") { askTitle(); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") { if (lastTab[current]) closeTab(lastTab[current]); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") { setSide($("#side").classList.contains("collapsed")); return false; }
  if (e.ctrlKey && e.code === "Tab") {
    const ids = tabsOf(current).map((s) => s.id);
    if (ids.length) focusTab(ids[(ids.indexOf(lastTab[current]) + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
    return false;
  }
  return true;
}
document.addEventListener("keydown", (e) => { if (!shortcuts(e)) e.preventDefault(); });

const KEYS = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", ctrlc: "\x03" };
function setCtrl(t, on) { t.ctrl = on; $('#keys [data-k="ctrl"]').classList.toggle("on", on); }
$("#keys").onclick = (e) => {
  const k = e.target.dataset.k;
  const t = terms.get(lastTab[current]);
  if (!k || !t) return;
  if (k === "ctrl") setCtrl(t, !t.ctrl); else send(t, { t: "i", d: KEYS[k] });
  t.term.focus();
};

function setSide(open) {
  $("#side").classList.toggle("collapsed", !open);
  $("#expand").hidden = open;
  store.set("side", open);
  requestAnimationFrame(() => { const t = terms.get(lastTab[current]); if (t) t.fit.fit(); });
}
$("#collapse").onclick = () => setSide(false);
$("#expand").onclick = () => setSide(true);
setSide(store.get("side", true));

$("#plus").onclick = askTitle;
$("#new").onclick = openPicker;
$("#find").onclick = openPalette;
$("#menu").onclick = () => $("#side").classList.toggle("show");
$("#stage").onclick = () => $("#side").classList.remove("show");

// ---- start
(async () => {
  if (!(await login())) {
    document.body.innerHTML = `<p style="padding:40px;color:#9a9aa2">Abrí Atril con <b style="color:#e6e6ea">atr open</b>: trae la llave de esta computadora.</p>`;
    return;
  }
  events();
  // the first list arrives on the events socket; then show what was asked, or the last space
  const ready = setInterval(() => {
    if (!spaces.length && !sessions.size) return;
    clearInterval(ready);
    if (wanted) show(wanted);
    else if (current) selectSpace(current);
  }, 100);
})();
