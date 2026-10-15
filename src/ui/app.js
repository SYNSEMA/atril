// Atril UI. Machines hold spaces; a space is a folder (with its git branch); its tabs are the sessions
// that run there. The agents list shows only agents, from every space of every machine. This window
// only talks to the daemon of this computer: another machine is reached through it (/api/m/<id>/…),
// over the SSH link that daemon keeps open. Closing a tab only hides it and closes its socket.
//
// The screen has two modes, never both at once:
//   space mode (this file): one space selected in the sidebar, its tabs on top, one terminal.
//   board mode (board.js): no space selected; up to four terminals of any space of any device at once.
// Code that asks "which terminal is on screen / gets the keys" uses activeKey() and onScreen(), never
// lastTab[current] directly: in board mode lastTab[current] is a tab that is not on screen.
"use strict";

const $ = (s) => document.querySelector(s);
const WS = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const LOCAL = "local";
// the window's title, the same in every space and on the board: the bar of the window and the taskbar say it
const APP_TITLE = "Atril · gestioná todos tus agentes y dispositivos en un mismo lugar";
document.title = APP_TITLE;

// machines: this one first, then the connected ones. {mid, name, status, error, target}
let machines = [{ mid: LOCAL, name: "", status: "up" }];
let myVersion = "";           // this computer's Atril; a machine with another can be updated
const sessions = new Map();   // "mid/id" -> metadata (with .mid and .key)
const spacesBy = {};          // mid -> [{key, path, name, branch}]
const feeds = {};             // mid -> its events socket
const outsideBy = {};         // mid -> agents running there outside Atril (seen, not attachable)
const terms = new Map();      // session key -> {term, fit, ws, el, ...}
let wanted = null;            // `atr open <session>`: the tab to show first

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let current = store.get("space2", null);                 // "mid|space key" on screen
let machineSel = store.get("machine", LOCAL);           // the machine whose spaces the sidebar lists
const hidden = new Set(store.get("hidden2", []));        // session keys whose tab was closed here
const lastTab = store.get("lastTab2", {});               // "mid|space" -> the session key it showed last

const base = (mid) => (mid === LOCAL ? "/api" : `/api/m/${encodeURIComponent(mid)}`);
const skey = (mid, id) => `${mid}/${id}`;
const spaceId = (mid, key) => `${mid}|${key}`;
const machineOf = (mid) => machines.find((m) => m.mid === mid);
const loaded = new Set();     // machines whose whole list of sessions arrived (a session missing there is gone)

// board.js owns BOARD; these three are all this file needs to know about it
const boardOn = () => typeof BOARD !== "undefined" && BOARD.on;
const activeKey = () => (boardOn() ? BOARD.focus : lastTab[current]);   // the terminal your keys go to
const onScreen = (key) => (boardOn() ? BOARD.keys.includes(key) : key === lastTab[current]);

// ---- login: `atr open` brings the key in the fragment; it becomes an HttpOnly cookie
async function login() {
  const m = location.hash.match(/t=([\w-]+)/);
  const want = location.hash.match(/s=([^&]+)/);
  if (want) wanted = decodeURIComponent(want[1]);
  const headers = m ? { Authorization: "Bearer " + m[1] } : {};
  if (m) history.replaceState(null, "", location.pathname);
  const r = await fetch("/api/login", { method: "POST", headers, credentials: "same-origin" });
  if (!r.ok) return false;
  const me = await r.json();
  machines[0].name = me.machine;
  myVersion = me.version || "";
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
const untitled = (s) => /^[a-z-]+-\d+$/.test(s.name);
function label(s) {
  const st = statusOf(s);
  if (st === "exited") return "terminó";
  if (st === "bell") return "te necesita";
  if (st === "working") return "trabajando";
  return isAgent(s) ? (unseen.has(s.key) ? "terminó, sin ver" : "esperándote") : "inactiva";
}
const allSessions = () => [...sessions.values()];
const inSpace = (sid) => allSessions().filter((s) => spaceId(s.mid, s.space) === sid).sort((a, b) => a.started - b.started);
function spaceOf(sid) {
  if (!sid) return null;
  const [mid, key] = sid.split("|");
  const sp = (spacesBy[mid] || []).find((x) => x.key === key);
  return sp ? { ...sp, mid, sid } : null;
}
function tabName(s, i) {
  if (!untitled(s)) return s.name;
  return isAgent(s) ? s.kind : String(i + 1);
}
// what runs now and where, first; the program the session started with last
function tooltip(s) {
  const what = isAgent(s) ? s.kind : "terminal";
  const started = `${s.cmd} ${(s.args || []).join(" ")}`.trim();
  const where = s.mid === LOCAL ? "" : ` · en ${(machineOf(s.mid) || {}).name}`;
  return `${s.name} — ${what}, ${label(s)}${where}\n${s.here || s.cwd}\npid ${s.pid} · ${s.id} · empezó con: ${started}`;
}
function ago(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return Math.floor(d) + "s";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}

// ---- each machine's events: its sessions and spaces, live
function feed(mid) {
  if (feeds[mid]) return;
  const ws = new WebSocket(WS + base(mid) + "/events");
  feeds[mid] = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "show") { if (mid === LOCAL) show(m.ref); return; }
    if (m.t === "machines") { if (mid === LOCAL) setMachines(m.machines); return; }
    if (m.t === "outside") { outsideBy[mid] = m.list; renderSide(); return; }
    if (m.t === "spaces") spacesBy[mid] = m.spaces;
    else if (m.t === "all") {
      for (const k of [...sessions.keys()]) if (k.startsWith(mid + "/")) sessions.delete(k);
      for (const s of m.sessions) put(mid, s);
      spacesBy[mid] = m.spaces;
      loaded.add(mid);
      if (mid === LOCAL && m.machines) setMachines(m.machines);
      if (!spaceOf(current) && mid === LOCAL) current = (spacesBy[LOCAL][0] && spaceId(LOCAL, spacesBy[LOCAL][0].key)) || null;
    } else if (m.session.status === "removed") { sessions.delete(skey(mid, m.session.id)); dropTerm(skey(mid, m.session.id)); }
    else put(mid, m.session);
    renderSide();
  };
  ws.onclose = () => {
    delete feeds[mid];
    const mm = machineOf(mid);
    if (mid === LOCAL || (mm && mm.status === "up")) setTimeout(() => feed(mid), 2000);
  };
}
// an agent that finished its work while you were looking elsewhere: green until you open its tab
const unseen = new Set();
function put(mid, s) {
  const key = skey(mid, s.id), prev = sessions.get(key);
  if (prev && prev.activity === "working" && s.activity !== "working" && s.status === "running" && (!onScreen(key) || document.hidden)) unseen.add(key);
  sessions.set(key, { ...s, mid, key });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && unseen.delete(activeKey())) renderSide(); });
// the dot of a session: bell (it asks for you), working, done (finished, not seen yet), exited; an
// agent you already saw waiting gets `idle` (a hollow ring where a list wants one, else nothing)
function dotOf(s, idle = "none") {
  const st = statusOf(s);
  if (st !== "idle") return st;
  return isAgent(s) && unseen.has(s.key) ? "done" : isAgent(s) ? idle : "none";
}

// the machines this daemon keeps linked: open a feed for each one that is up
function setMachines(list) {
  machines = [machines[0], ...list.map((x) => ({ mid: x.id, name: x.name, status: x.status, error: x.error, target: x.target, version: x.version }))];
  for (const m of machines.slice(1)) {
    if (m.status === "up") feed(m.mid);
    else if (feeds[m.mid]) feeds[m.mid].close();
  }
  // a machine that is gone takes its sessions with it
  for (const k of [...sessions.keys()]) if (!machineOf(k.split("/")[0])) { sessions.delete(k); dropTerm(k); }
  renderSide();
}

// the branch can change under us (git checkout in a tab): look again now and then
setInterval(async () => {
  for (const m of machines) {
    if (m.status !== "up") continue;
    try { spacesBy[m.mid] = (await api("GET", base(m.mid) + "/spaces")).items; } catch {}
  }
  renderSide();
}, 15000);

// ---- sidebar
const STATUS_TEXT = { up: "conectada", connecting: "conectando…", down: "sin conexión, reintentando" };
const ALIASES = store.get("aliases", {});      // mid -> the name you gave that machine (present.js)
const machineName = (mm) => ALIASES[mm.mid] || mm.name || (mm.mid === LOCAL ? "esta computadora" : mm.target);
const ICON_LAPTOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>';
const ICON_SERVER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>';

// a machine's tab shows its spaces and the space you used last there (or its first one)
const lastSpace = store.get("lastSpace", {});   // mid -> space id
function selectMachine(mid) {
  machineSel = mid;
  store.set("machine", mid);
  // on the board a device only says whose spaces the sidebar lists: you bring them in from there
  if (boardOn()) { renderSide(); return; }
  const list = spacesBy[mid] || [];
  const busy = list.find((sp) => tabsOf(spaceId(mid, sp.key)).length);
  const want = spaceOf(lastSpace[mid]) ? lastSpace[mid] : (busy || list[0]) ? spaceId(mid, (busy || list[0]).key) : null;
  if (want) selectSpace(want);
  else { current = null; showOnly(null); renderSide(); }
}

const SPACES_SHOWN = 3;
const spaceUsed = store.get("spaceUsed", {});   // space id -> when you last were in it
let spacesAll = store.get("spacesAll", false);
function useSpace(sid) {
  if (!sid || Date.now() - (spaceUsed[sid] || 0) < 1000) return;
  spaceUsed[sid] = Date.now();
  store.set("spaceUsed", spaceUsed);
}

function renderSide() {
  if (!machineOf(machineSel)) machineSel = LOCAL;
  const many = machines.length > 1;

  // devices: this computer first, then the connected ones; a status only when there is one to say
  const dl = $("#devices");
  dl.innerHTML = "";
  for (const mm of machines) {
    const li = document.createElement("li");
    li.className = mm.mid === machineSel ? "on" : "";
    const old = mm.mid !== LOCAL && mm.status === "up" && mm.version !== myVersion;
    const [txt, cls] = mm.mid === LOCAL ? ["esta PC", ""]
      : mm.status === "connecting" ? ["conectando…", "busy"]
      : mm.status !== "up" ? ["sin conexión", "warn"]
      : old ? ["actualizar ↑", "upd"] : ["", ""];
    li.innerHTML = `<span class="ic">${mm.mid === LOCAL ? ICON_LAPTOP : ICON_SERVER}</span><span class="dn"></span><span class="ds ${cls}"></span>`;
    li.querySelector(".dn").textContent = machineName(mm);
    li.querySelector(".ds").textContent = txt;
    li.title = mm.mid === LOCAL ? "Esta computadora"
      : `${mm.target} · ${STATUS_TEXT[mm.status] || mm.status}${mm.error ? "\n" + mm.error : ""}${old ? `\nTiene Atril ${mm.version || "viejo"}; acá está ${myVersion}: clic derecho → Actualizar Atril ahí` : ""}\n(clic derecho: reconectar, actualizar, desconectar)`;
    li.onclick = () => { if (old && mm.mid === machineSel) return updateMachine(mm); selectMachine(mm.mid); };
    li.oncontextmenu = (e) => { e.preventDefault(); showMachineMenu(mm, e.clientX, e.clientY); };
    dl.append(li);
  }

  // the spaces of the machine chosen above
  const ul = $("#spaces");
  ul.innerHTML = "";
  const mm = machineOf(machineSel);
  $("#spwhere").textContent = many ? "· " + machineName(mm) : "";
  const list = spacesBy[mm.mid] || [];
  if (mm.mid !== LOCAL && mm.status !== "up") {
    const li = document.createElement("li");
    li.className = "mempty";
    li.textContent = mm.status === "connecting" ? "conectando…" : "sin conexión, reintentando…";
    if (mm.error) li.title = mm.error;
    ul.append(li);
  } else if (!list.length) {
    const li = document.createElement("li");
    li.className = "mempty";
    li.textContent = `Ningún space en ${machineName(mm)} todavía: «+ nuevo» abre una carpeta.`;
    ul.append(li);
  }
  // the ones used last first; three of them unless you ask for all (the one on screen is always there)
  const used = (sp) => spaceUsed[spaceId(mm.mid, sp.key)] || 0;
  const sorted = list.map((sp, i) => [sp, i]).sort((a, b) => used(b[0]) - used(a[0]) || a[1] - b[1]).map((x) => x[0]);
  let shown = sorted;
  if (!spacesAll && sorted.length > SPACES_SHOWN + 1) {
    shown = sorted.slice(0, SPACES_SHOWN);
    const cur = sorted.find((sp) => spaceId(mm.mid, sp.key) === current);
    if (cur && !shown.includes(cur)) shown = [...shown.slice(0, SPACES_SHOWN - 1), cur];
  }
  for (const sp of shown) ul.append(spaceItem(mm, sp));
  if (sorted.length > SPACES_SHOWN + 1) {
    const rest = sorted.filter((sp) => !shown.includes(sp));
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = spacesAll ? "ver menos" : `ver todos (${sorted.length})`;
    // a hidden space where an agent needs you, or finished, says so on the button
    const waiting = rest.flatMap((sp) => inSpace(spaceId(mm.mid, sp.key)).filter((s) => s.status === "running").map((s) => dotOf(s)));
    const dot = ["bell", "done"].find((d) => waiting.includes(d));
    if (dot) li.insertAdjacentHTML("afterbegin", `<span class="st ${dot}"></span>`);
    li.title = spacesAll ? "Mostrar solo los últimos usados" : rest.map((sp) => sp.name).join(", ");
    li.onclick = () => { spacesAll = !spacesAll; store.set("spacesAll", spacesAll); renderSide(); };
    ul.append(li);
  }

  const agents = allSessions().filter(isAgent);
  $("#count").textContent = agents.length ? `${agents.filter((s) => s.status === "running").length} vivos` : "";
  const al = $("#agents");
  al.innerHTML = "";
  if (!agents.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "ninguno todavía: corré claude, codex… en una pestaña";
    al.append(li);
  }
  for (const m2 of machines) {
    for (const sp of spacesBy[m2.mid] || []) {
      const group = agents.filter((s) => s.mid === m2.mid && s.space === sp.key);
      if (!group.length) continue;
      const g = document.createElement("li");
      g.className = "group";
      g.textContent = (many ? machineName(m2) + " · " : "") + sp.name + (sp.branch ? " · " + sp.branch : "");
      al.append(g);
      for (const s of group) al.append(agentItem(s));
    }
  }
  for (const m2 of machines) {
    const out = outsideBy[m2.mid] || [];
    if (!out.length) continue;
    const g = document.createElement("li");
    g.className = "group";
    g.textContent = "fuera de Atril" + (many ? " · " + machineName(m2) : "");
    g.title = "Agentes que corren en esta máquina pero no dentro de Atril (abiertos desde otra terminal o por SSH)";
    al.append(g);
    for (const o of out) al.append(outsideItem(m2, o));
  }
  paintBoardBtn();   // board.js
  renderTabs();
}

// an agent Atril sees running but does not own: its screen is in another terminal
function outsideItem(mm, o) {
  const li = document.createElement("li");
  li.className = "outside";
  li.innerHTML = `<span class="st exited"></span><span class="name"></span><span class="meta"></span><span class="sub"></span>`;
  li.querySelector(".name").textContent = o.kind;
  li.querySelector(".meta").textContent = o.age != null ? ago(Date.now() / 1000 - o.age) : "";
  li.querySelector(".sub").textContent = `pid ${o.pid}${o.cwd ? " · " + o.cwd : ""}`;
  li.title = `${o.kind} corre en ${machineName(mm)} fuera de Atril (pid ${o.pid}).\nSu pantalla está en la terminal donde lo abrieron: Atril no puede mostrarla ni mantenerlo vivo si esa terminal se cierra.\nPara tenerlo acá, abrilo con «atr ${o.kind}» en esa máquina, o desde una pestaña de Atril.`;
  li.onclick = () => notice(li.title);
  return li;
}

function spaceItem(mm, sp) {
  const sid = spaceId(mm.mid, sp.key);
  const list = inSpace(sid);
  const li = document.createElement("li");
  li.className = sid === current && !boardOn() ? "on" : "";   // on the board no space is selected
  li.title = sp.path;
  const running = list.filter((s) => s.status === "running");
  // a dot only when there is something to look at: what asks for you first, then what finished, then work going on
  const dots = running.map((s) => dotOf(s));
  const dot = ["bell", "done", "working"].find((d) => dots.includes(d)) || "none";
  li.title = sp.path + ({ bell: "\nun agente te necesita", done: "\nun agente terminó y no lo viste", working: "\nalgo está trabajando" }[dot] || "");
  li.innerHTML = `<span class="st ${dot}"></span><span class="name"></span><span class="meta"></span><span class="branch"></span>`;
  li.querySelector(".name").textContent = sp.name;
  li.querySelector(".meta").textContent = running.length || "";
  li.querySelector(".branch").textContent = sp.branch || "";
  li.onclick = () => { selectSpace(sid); $("#side").classList.remove("show"); };
  li.oncontextmenu = (e) => { e.preventDefault(); showSpaceMenu({ ...sp, mid: mm.mid, sid }, e.clientX, e.clientY); };
  boardDraggable(li, { sid });   // board.js: dropped on the terminal, the space goes to the board
  return li;
}

function agentItem(s) {
  const li = document.createElement("li");
  const st = statusOf(s);
  li.className = onScreen(s.key) ? "open" : "";
  li.title = tooltip(s);
  li.innerHTML = `<span class="st ${dotOf(s, "wait")}"></span><span class="name"></span><span class="meta"></span><span class="sub"></span>`;
  li.querySelector(".name").textContent = untitled(s) ? s.kind : s.name;
  li.querySelector(".meta").textContent = s.status === "exited" ? "exit " + (s.exit_code ?? "?") : ago(s.started);
  const title = s.title && s.status === "running" && !/[\\/].*\.(exe|cmd)$/i.test(s.title) ? s.title : null;
  li.querySelector(".sub").textContent = `${label(s)}${title ? " · " + title : ""}`;
  // on the board, one of its terminals is focused there; anything else goes to its space
  li.onclick = () => { if (boardOn() && BOARD.keys.includes(s.key)) boardFocus(s.key); else reveal(s.key); $("#side").classList.remove("show"); };
  li.oncontextmenu = (e) => { e.preventDefault(); showCtx(s.key, e.clientX, e.clientY); };
  boardDraggable(li, { key: s.key });
  let press;
  li.ontouchstart = (e) => { press = setTimeout(() => showCtx(s.key, e.touches[0].clientX, e.touches[0].clientY), 550); };
  li.ontouchend = li.ontouchmove = () => clearTimeout(press);
  return li;
}

// ---- spaces and tabs
function selectSpace(sid) {
  leaveBoard();   // board.js: choosing a space is space mode
  current = sid;
  useSpace(sid);
  if (sid) { lastSpace[sid.split("|")[0]] = sid; store.set("lastSpace", lastSpace); }
  const sp = spaceOf(sid);
  if (sp && sp.mid !== machineSel) { machineSel = sp.mid; store.set("machine", machineSel); }
  store.set("space2", sid);
  const visible = tabsOf(sid);
  const want = visible.find((s) => s.key === lastTab[sid]) || visible[visible.length - 1];
  if (want) focusTab(want.key); else { showOnly(null); renderSide(); }
}

const tabsOf = (sid) => inSpace(sid).filter((s) => !hidden.has(s.key));

let editing = false;          // a tab title being typed: the bar must not be redrawn under it
function renderTabs() {
  if (editing) return;
  if (boardOn()) return renderBoard();   // board.js draws the bar and the terminals
  const bar = $("#tablist");
  bar.innerHTML = "";
  const list = tabsOf(current);
  list.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (s.key === lastTab[current] ? " on" : "");
    el.dataset.key = s.key;
    el.ondblclick = (e) => { if (e.target !== el.querySelector(".x")) renameTab(s.key); };
    el.innerHTML = `<span class="st ${dotOf(s)}"></span><span class="t"></span><button class="x"></button>`;
    el.querySelector(".t").textContent = tabName(s, i);
    const x = el.querySelector(".x");
    x.textContent = "×";
    x.title = s.status === "running" ? "Cerrar pestaña (el programa sigue: está en agents / find)" : "Cerrar y olvidar";
    el.title = tooltip(s) + "\n(doble clic para ponerle título · mantené apretado para llevarla al tablero, o Ctrl+Shift+D)";
    el.onclick = (e) => { if (e.target !== x && e.target.tagName !== "INPUT") focusTab(s.key); };
    x.onclick = () => closeTab(s.key);
    el.onauxclick = (e) => { if (e.button === 1) closeTab(s.key); };
    el.oncontextmenu = (e) => { e.preventDefault(); showCtx(s.key, e.clientX, e.clientY); };
    boardDraggable(el, { key: s.key });
    boardHold(el, s.key);   // held still, the tab comes off the bar and the board opens with it
    bar.append(el);
  });
  const sp = spaceOf(current);
  $("#empty").hidden = list.length > 0;
  $("#empty-title").textContent = sp ? `${sp.name} no tiene terminales abiertas.` : "Creá un space con new.";
  if (typeof filesSync === "function") filesSync();   // the panel of files follows the space on screen
}

// show a session wherever it is: its machine, its space, its tab
function reveal(key) {
  const s = sessions.get(key);
  if (!s) return;
  leaveBoard();
  hidden.delete(key);
  store.set("hidden2", [...hidden]);
  current = spaceId(s.mid, s.space);
  store.set("space2", current);
  machineSel = s.mid;
  store.set("machine", machineSel);
  focusTab(key);
}

function focusTab(key) {
  const s = sessions.get(key);
  if (!s) return;
  leaveBoard();
  lastTab[spaceId(s.mid, s.space)] = key;
  store.set("lastTab2", lastTab);
  useSpace(spaceId(s.mid, s.space));
  unseen.delete(key);
  const t = terms.get(key) || makeTerm(s);
  if (typeof VIEW !== "undefined" && VIEW) minimizeViewer(false);   // a tab chosen: back to the terminal, the file waits
  showOnly(key);
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
  renderSide();
}

function showOnly(key) { for (const [k, t] of terms) t.el.hidden = k !== key; }

function closeTab(key) {
  const s = sessions.get(key);
  dropTerm(key);
  if (s && s.status !== "running") api("DELETE", `${base(s.mid)}/sessions/${s.id}`).catch(() => {});   // ended: nothing to keep
  else { hidden.add(key); store.set("hidden2", [...hidden]); }
  if (lastTab[current] === key) delete lastTab[current];
  // on the board it leaves the board too (a session that is gone would reconnect forever in its pane)
  if (boardOn()) { if (BOARD.keys.includes(key)) boardRemove(key); else renderSide(); return; }
  const rest = tabsOf(current).filter((x) => x.key !== key);
  if (rest.length) focusTab(rest[rest.length - 1].key); else { showOnly(null); renderSide(); }
}

function dropTerm(key) {
  const t = terms.get(key);
  if (!t) return;
  t.closing = true;
  t.ws && t.ws.close();
  t.term.dispose();
  t.el.remove();
  terms.delete(key);
}

// a new session: on the machine given, else on the device chosen in the sidebar; in the space on
// screen when it is that machine's, else in the user's home folder there (which becomes a space).
// It is shown in its space unless show is false (the board places it itself); gives its key
async function newTab(body = {}, onMid = null, show = true) {
  const mid = onMid || machineSel;
  const cur = spaceOf(current);
  const sp = cur && cur.mid === mid ? cur : null;
  const t = terms.get(activeKey());
  const s = await api("POST", base(mid) + "/sessions", {
    cols: t ? t.term.cols : 120, rows: t ? t.term.rows : 32,
    cwd: sp ? sp.path : undefined, ...body,
  });
  put(mid, s);
  if (show) reveal(skey(mid, s.id));
  return skey(mid, s.id);
}

// the same program again, in the same folder and with the same name
async function restart(key) {
  const s = sessions.get(key);
  if (!s) return;
  const at = boardOn() ? BOARD.keys.indexOf(key) : -1;   // a pane of the board: the new one takes its place
  dropTerm(key);
  await api("DELETE", `${base(s.mid)}/sessions/${s.id}`);
  sessions.delete(key);
  if (at < 0) current = spaceId(s.mid, s.space);
  const nk = await newTab({ cmd: s.cmd, args: s.args, cwd: s.cwd, name: s.name }, s.mid, at < 0);
  if (at >= 0) boardReplace(key, nk, at);
}

// `atr open [session]` while this window is open: show it here
function show(ref) {
  window.focus();
  if (!ref) return;
  const s = allSessions().filter((x) => x.mid === LOCAL).reverse().find((x) => [x.id, x.name, String(x.pid)].includes(ref));
  if (s) reveal(s.key);
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
  if (e.key === "Enter") { const name = e.target.value.trim(); endAsk(); newTab(name ? { name } : {}).catch((err) => notice(err.message)); }
  else if (e.key === "Escape") { endAsk(); const t = terms.get(activeKey()); if (t) t.term.focus(); }
};
$("#newtitle").onblur = endAsk;

function renameTab(key) {
  const el = document.querySelector(`.tab[data-key="${CSS.escape(key)}"] .t`);
  const s = sessions.get(key);
  if (!el || !s) return;
  const input = document.createElement("input");
  input.value = untitled(s) ? "" : s.name;
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
      try { await api("POST", `${base(s.mid)}/sessions/${s.id}/rename`, { name }); } catch (err) { notice(err.message); }
    }
    renderTabs();
    const t = terms.get(key);
    if (t) t.term.focus();
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); e.stopPropagation(); };
  input.onblur = () => finish(true);
}

// ---- one terminal per tab that was shown
function makeTerm(s) {
  const el = document.createElement("div");
  el.className = "term";
  $("#stage").append(el);
  const term = new Terminal({
    fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"),
    fontSize: 14, cursorBlink: true, allowProposedApi: true, scrollback: 10000,
    theme: termTheme(), minimumContrastRatio: termContrast(),   // theme.js
    linkHandler: termLinkHandler(s.key),                        // files.js
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const t = { term, fit, el, ws: null, ctrl: false };
  term.attachCustomKeyEventHandler((e) => shortcuts(e) && clipboardKeys(t, e));
  clipboardMouse(t);
  fileLinks(t, s.key);   // files.js: a path printed in the terminal opens with a click
  el.addEventListener("pointerdown", () => claim(t));
  touchScroll(el);
  terms.set(s.key, t);
  connect(s, t);
  term.onData((d) => {
    if (t.ended || t.replaying) return;
    claim(t);
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

// ---- a finger on a phone scrolls like a mouse wheel: the history of the terminal, or the program itself
// when it handles the wheel (an agent, less, vim). A drag of a few pixels is a scroll; a tap stays a tap
function touchScroll(el) {
  let y = null, moved = false, acc = 0;
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { y = null; return; }
    y = e.touches[0].clientY; moved = false; acc = 0;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (y === null || e.touches.length !== 1) return;
    const ny = e.touches[0].clientY;
    acc += y - ny;
    y = ny;
    if (!moved && Math.abs(acc) < 8) return;
    moved = true;
    e.preventDefault();
    const target = el.querySelector(".xterm-screen") || el;
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: acc / 2, deltaMode: 0,   // xterm moves about twice the pixels of a wheel: /2 follows the finger
      bubbles: true, cancelable: true, clientX: e.touches[0].clientX, clientY: ny }));
    acc = 0;
  }, { passive: false });
  el.addEventListener("touchend", (e) => { if (moved) e.preventDefault(); y = null; }, { passive: false });
}

// ---- copy and paste in a terminal, as in Windows Terminal: Ctrl+C copies when there is a selection
// (else it is the program's Ctrl+C), Ctrl+V pastes, and so do Ctrl+Shift+C / Ctrl+Shift+V. When
// the clipboard holds an image and no text, the program gets the key itself: agents (Claude Code,
// OpenCode…) read the image from the clipboard on their own
function copySelection(t) {
  const text = t.term.getSelection();
  if (!text) return false;
  navigator.clipboard.writeText(text).catch(() => {});
  t.term.clearSelection();
  return true;
}
function clipboardKeys(t, e) {
  if (!e.ctrlKey || e.altKey || e.metaKey) return true;
  if (e.code === "KeyC") {
    if (e.type === "keydown" && t.term.hasSelection()) { copySelection(t); return false; }
    return !e.shiftKey;   // Ctrl+Shift+C with nothing selected does nothing
  }
  // false: xterm leaves the key alone and the browser's own paste follows (the paste handler below)
  if (e.code === "KeyV") return false;
  return true;
}
// what a paste event brings: the text through xterm (bracketed paste included); an image alone, the key
function pasteImageKey(t, data) {
  const hasText = !!data.getData("text/plain");
  const hasImage = [...(data.items || [])].some((i) => i.kind === "file" && i.type.startsWith("image/"));
  if (!hasText && hasImage) { send(t, { t: "i", d: "\x16" }); return true; }
  return false;
}
async function pasteClipboard(t) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { t.term.paste(text); return; }
    const items = await navigator.clipboard.read();
    if (items.some((i) => i.types.some((ty) => ty.startsWith("image/")))) send(t, { t: "i", d: "\x16" });
  } catch {}
}
function clipboardMouse(t) {
  t.el.addEventListener("paste", (e) => {
    if (e.clipboardData && pasteImageKey(t, e.clipboardData)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // right click inside the terminal: copy the selection, or paste when there is none (no browser menu)
  t.el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!copySelection(t)) pasteClipboard(t);
    t.term.focus();
  });
}

function connect(s, t) {
  const ws = new WebSocket(WS + base(s.mid) + "/sessions/" + encodeURIComponent(s.id) + "/attach");
  t.ws = ws;
  // the first output is the history being replayed: queries in it ("what terminal are you?") would be
  // answered again by xterm.js and typed into the program (a stray "1;2c"), so answers are dropped
  // until it is drawn
  t.replaying = true;
  let first = true;
  ws.onopen = () => { t.fit.fit(); t.claimed = true; send(t, { t: "r", cols: t.term.cols, rows: t.term.rows }); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "o") {
      // through present.js: while presenting, what is yours is covered before it is drawn
      if (first) { first = false; maskWrite(t, m.d, () => { t.replaying = false; }); }
      else maskWrite(t, m.d);
    } else if (m.t === "exit") {
      t.replaying = false;
      if (t.ended) return;
      t.ended = true;
      const cur = sessions.get(s.key) || s;
      t.term.write(`\r\n\x1b[2m── ${cur.name} terminó (código ${m.code ?? "?"}) ──\x1b[0m\r\n`);
      const end = document.createElement("div");
      end.className = "ended";
      end.innerHTML = `<span></span><button>Reiniciar</button>`;
      end.firstChild.textContent = `terminó · código ${m.code ?? "?"}`;
      end.lastChild.onclick = () => restart(s.key);
      t.el.append(end);
    } else if (m.t === "size") { if (!m.mine) t.claimed = false; }   // another window (a phone) set its size
    else if (m.t === "error") closeTab(s.key);   // a session that is gone
  };
  ws.onclose = () => {
    // the daemon, the link or the network went away; the session may still be alive: try again
    if (terms.get(s.key) === t && !t.closing) setTimeout(() => { if (terms.get(s.key) === t) { t.term.reset(); connect(s, t); } }, 2000);
  };
}

function send(t, m) { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify(m)); }

// one terminal, several windows (this computer, a phone) and one size: the window used last gets it back
// when you type, touch it, or come back to it
function claim(t) {
  if (!t || t.claimed || !t.ws || t.ws.readyState !== 1) return;
  t.claimed = true;
  t.fit.fit();
  send(t, { t: "r", cols: t.term.cols, rows: t.term.rows });
}
const claimActive = () => claim(terms.get(activeKey()));
window.addEventListener("focus", claimActive);
document.addEventListener("visibilitychange", () => { if (!document.hidden) claimActive(); });

window.addEventListener("resize", () => { const t = terms.get(activeKey()); if (t) t.fit.fit(); });

// ---- palette: any session of any space of any machine. On the board a pick goes to the board instead
// of to its space, and every space of every device offers a new terminal there too
function openPalette() {
  $("#palette").hidden = false;
  $("#q").value = "";
  $("#q").placeholder = boardOn() ? "sumar al tablero: nombre, comando, space, dispositivo…" : "nombre, comando, pid o id…";
  paint();
  $("#q").focus();
}
let sel = 0;
// entries: {s} a session, or {sp} a space where a new terminal opens (board only)
function matches() {
  const q = $("#q").value.toLowerCase().trim();
  const hit = (vals) => !q || vals.some((v) => v && String(v).toLowerCase().includes(q));
  const list = allSessions().filter((s) =>
    hit([s.name, s.cmd, s.title, s.cwd, s.here, String(s.pid), s.id, s.kind, (machineOf(s.mid) || {}).name])).map((s) => ({ s }));
  if (boardOn()) {
    for (const mm of machines) {
      if (mm.status !== "up") continue;
      for (const sp of spacesBy[mm.mid] || []) {
        if (hit([sp.name, sp.path, sp.branch, machineName(mm)])) list.push({ sp: { ...sp, mid: mm.mid, sid: spaceId(mm.mid, sp.key) } });
      }
    }
  }
  return list;
}
function paint() {
  const ul = $("#results");
  ul.innerHTML = "";
  const list = matches();
  sel = Math.min(sel, Math.max(0, list.length - 1));
  list.forEach((x, i) => {
    const li = document.createElement("li");
    li.className = i === sel ? "sel" : "";
    if (x.sp) {
      li.innerHTML = `<span class="st none"></span><span></span><span class="meta"></span>`;
      li.children[1].textContent = "+ terminal nueva en " + x.sp.name;
      li.children[2].textContent = [machineName(machineOf(x.sp.mid)), x.sp.branch].filter(Boolean).join(" · ");
    } else {
      const s = x.s;
      li.innerHTML = `<span class="st ${statusOf(s)}"></span><span></span><span class="meta"></span>`;
      li.children[1].textContent = untitled(s) && isAgent(s) ? s.kind : s.name;
      const sp = spaceOf(spaceId(s.mid, s.space));
      const where = (machines.length > 1 ? ((machineOf(s.mid) || {}).name || "") + " · " : "") + (sp ? sp.name : s.cwd);
      const on = boardOn() && BOARD.keys.includes(s.key) ? " · en el tablero" : "";
      li.children[2].textContent = `${where} · ${isAgent(s) ? s.kind : "terminal"} · pid ${s.pid}${on}`;
    }
    li.onclick = () => pick(x);
    ul.append(li);
  });
}
function pick(x) {
  $("#palette").hidden = true;
  if (x.sp) boardNew(x.sp).catch((err) => notice(err.message));
  else if (boardOn()) boardAdd(x.s.key);
  else reveal(x.s.key);
}
$("#q").oninput = () => { sel = 0; paint(); };
$("#q").onkeydown = (e) => {
  const list = matches();
  if (e.key === "ArrowDown") { sel = Math.min(sel + 1, list.length - 1); paint(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
  else if (e.key === "Enter" && list[sel]) pick(list[sel]);
  else if (e.key === "Escape") $("#palette").hidden = true;
};
$("#palette").onclick = (e) => { if (e.target.id === "palette") $("#palette").hidden = true; };

// ---- new space: recent repositories first, then browse any folder, on any machine
const picker = { mid: LOCAL, mode: "suggest", path: null, parent: null, branch: null, items: [], sel: 0 };
const pathLike = (v) => /[\\/:]/.test(v);

async function openPicker(mid) {
  picker.mid = mid || machineSel;
  const mm = machineOf(picker.mid);
  $("#pwhere").textContent = "· una carpeta de " + (picker.mid === LOCAL ? "esta computadora" : (mm ? mm.name : "la máquina"));
  $("#picker").hidden = false;
  $("#pq").value = "";
  $("#pmsg").textContent = "";
  picker.sel = 0;
  picker.items = [];
  paintPicker();
  $("#pq").focus();
  try {
    const r = await api("GET", base(picker.mid) + "/dirs/suggest");
    picker.mode = "suggest";
    picker.path = r.home;
    picker.items = r.repos.map((x) => ({ ...x, kind: "repo" }));
    picker.items.push({ kind: "browse", name: "Explorar carpetas…", path: r.home });
    paintPicker();
  } catch (e) { $("#pmsg").textContent = e.message; }
}
function closePicker() { $("#picker").hidden = true; const t = terms.get(activeKey()); if (t) t.term.focus(); }

async function pickerGo(path) {
  try {
    const r = await fetch(base(picker.mid) + "/dirs?path=" + encodeURIComponent(path), { credentials: "same-origin" }).then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.error); return j; });
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
    const { key } = await api("POST", base(picker.mid) + "/spaces", { path });
    $("#picker").hidden = true;
    // on the board with room left, its first terminal goes there; else to the new space, as always
    if (boardOn() && BOARD.keys.length < BOARD_MAX) return boardAdd(await newTab({ cwd: path }, picker.mid, false));
    current = spaceId(picker.mid, key);
    store.set("space2", current);
    await newTab({ cwd: path }, picker.mid);
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

// ---- connect a machine: user@host, the password once if it asks, then the link stays open
let connWs = null;
let connTimer = null;
const CONN_HINT = "La contraseña se usa una sola vez para dejar la llave de Atril. No se guarda.";
// while a connection is being set up, the dialog says it is alive: seconds since you pressed Conectar
function working(on) {
  clearInterval(connTimer);
  connTimer = null;
  $("#cgo").disabled = on;
  if (!on) { $("#cmsg").textContent = CONN_HINT; return; }
  const t0 = Date.now();
  const tick = () => { $("#cmsg").textContent = `Trabajando… ${Math.round((Date.now() - t0) / 1000)} s`; };
  tick();
  connTimer = setInterval(tick, 1000);
}
function openConnect(tab) {
  $("#conn").hidden = false;
  connTab(tab || "phone");
  $("#clog").innerHTML = "";
  $("#cpass").hidden = true;
  $("#cinstall").hidden = true;
  $("#cgo").hidden = false;
  $("#cgo").disabled = false;
  if (!$("#cssh").hidden) $("#ctarget").focus();
}
function closeConnect() {
  phoneStop();
  working(false);
  if (connWs) { connWs.close(); connWs = null; }
  $("#conn").hidden = true;
}
function logLine(text, cls) {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  $("#clog").append(li);
  li.scrollIntoView({ block: "nearest" });
}
function startConnect() {
  const target = $("#ctarget").value.trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(target)) { logLine("Escribí usuario@dirección, por ejemplo root@203.0.113.7", "err"); return; }
  $("#clog").innerHTML = "";
  working(true);
  logLine("Conectando con " + target + "…");
  const ws = new WebSocket(WS + "/api/machines/connect");
  connWs = ws;
  ws.onopen = () => ws.send(JSON.stringify({ target, port: Number($("#cport").value) || 22, name: $("#cname").value.trim() }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "step") { if (!m.msg.startsWith("Conectando con ")) logLine(m.msg); }
    else if (m.t === "ask" && m.what === "install") {
      $("#cinstallmsg").textContent = m.msg;
      $("#cinstall").hidden = false;
      $("#cyes").focus();
    } else if (m.t === "ask") {
      if (m.retry) logLine(m.msg, "err");
      $("#cpasslabel").textContent = m.msg;
      $("#cpass").hidden = false;
      $("#cpw").value = "";
      $("#cpw").focus();
    } else if (m.t === "done") {
      $("#cpass").hidden = true;
      $("#cinstall").hidden = true;
      const r = m.result || {};
      working(false);
      if (r.ok) {
        logLine(`Listo: ${r.name} queda conectada y se reconecta sola.`, "ok");
        $("#cgo").hidden = true;
        setTimeout(closeConnect, 1500);
      } else logLine(r.error || "No se pudo conectar.", "err");
      connWs = null;
    }
  };
  ws.onclose = () => { if (connWs === ws) { logLine("Se cortó la conexión con Atril.", "err"); working(false); connWs = null; } };
}
$("#cpass").onsubmit = (e) => {
  e.preventDefault();
  if (connWs) connWs.send(JSON.stringify({ password: $("#cpw").value }));
  $("#cpw").value = "";   // not kept here either
  $("#cpass").hidden = true;
};
function answerInstall(yes) {
  $("#cinstall").hidden = true;
  if (connWs) connWs.send(JSON.stringify({ install: yes }));
  if (yes) logLine("Instalando… (no cierres esta ventana)");
}
$("#cyes").onclick = () => answerInstall(true);
$("#cno").onclick = () => answerInstall(false);
$("#cgo").onclick = startConnect;
$("#ccancel").onclick = closeConnect;
$("#ctarget").onkeydown = (e) => { if (e.key === "Enter") startConnect(); };
$("#conn").onclick = (e) => { if (e.target.id === "conn") closeConnect(); };

// ---- a phone: where the relay runs (one question at a time, Atril does the work), then the QR
function connTab(t) {
  $("#cphone").hidden = t !== "phone";
  $("#cssh").hidden = t !== "ssh";
  for (const b of document.querySelectorAll(".ctabs button")) b.classList.toggle("on", b.dataset.tab === t);
  if (t === "phone") phoneStart(); else phoneStop();
}
for (const b of document.querySelectorAll(".ctabs button")) b.onclick = () => { connTab(b.dataset.tab); if (b.dataset.tab === "ssh") $("#ctarget").focus(); };

const phone = { timer: null, poll: null, known: null, place: null, mode: null, ws: null };
function phoneStop() {
  clearInterval(phone.timer);
  clearInterval(phone.poll);
  phone.timer = phone.poll = null;
  if (phone.ws) { phone.ws.close(); phone.ws = null; }
}
function view(v) {
  for (const el of document.querySelectorAll("#cphone .pv")) el.hidden = el.id !== "pv-" + v;
}
// how long, in words: 3 min, 5 h, 41 días
function dur(sec) {
  if (sec == null) return "";
  if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + " min";
  if (sec < 172800) return Math.round(sec / 3600) + " h";
  return Math.round(sec / 86400) + " días";
}
async function phoneStart() {
  phoneStop();
  view("places");
  $("#places").innerHTML = '<p class="loading">Buscando tus dispositivos y midiendo cada uno…</p>';
  try {
    const r = await api("GET", "/api/remote/relay");
    if (r.setup) { showQr(r); return; }
  } catch {}
  showPlaces();
}

// step 1: the devices it can run on, with what was measured on each
async function showPlaces() {
  view("places");
  const box = $("#places");
  box.innerHTML = '<p class="loading">Buscando tus dispositivos y midiendo cada uno…</p>';
  let r;
  try { r = await api("GET", "/api/remote/places"); } catch (e) { box.innerHTML = ""; box.append(line(e.message, "warn")); return; }
  box.innerHTML = "";
  for (const p of r.places) {
    const facts = [];
    if (p.this) {
      facts.push("esta computadora");
      if (p.up != null) facts.push(`prendida hace ${dur(p.up)}`);
    } else {
      facts.push(p.host);
      if (p.link !== "up") facts.push("no responde ahora");
      else {
        if (p.up != null) facts.push(`prendido hace ${dur(p.up)}`);
        facts.push(p.drops ? `su conexión se cortó ${p.drops} ${p.drops === 1 ? "vez" : "veces"} desde que abriste Atril` : `conectado sin cortes desde hace ${dur(Date.now() / 1000 - p.since)}`);
      }
    }
    const why = p.this ? "Para el teléfono, esta computadora ya tiene que estar prendida: el relay acá no suma otro equipo que dependa de estar prendido." : "";
    box.append(card(p.name, facts.join(" · "), why, p.link && p.link !== "up", () => { phone.place = p; showHow(); }));
  }
  if (r.synsema) {
    box.append(card("Relay de Synsema", "atril.synsema.io · corre en nuestros servidores",
      "Lo usás si no tenés otro dispositivo donde correrlo. Solo pasa datos cifrados entre tu teléfono y esta computadora: no puede leerlos. El teléfono llega mientras esta computadora esté prendida y con Atril abierto.",
      false, () => { phone.place = { id: "synsema", name: "Synsema" }; run("synsema"); }));
  } else {
    box.append(line("¿Otro servidor? Conectalo en «Servidor o computadora» y aparece acá.", "muted"));
  }
}
function card(title, facts, why, off, go) {
  const b = document.createElement("button");
  b.className = "card";
  b.disabled = off;
  const t = document.createElement("b");
  t.textContent = title;
  const f = document.createElement("span");
  f.className = "muted";
  f.textContent = facts;
  b.append(t, f);
  if (why) { const w = document.createElement("span"); w.className = "why"; w.textContent = why; b.append(w); }
  b.onclick = go;
  return b;
}
function line(text, cls) {
  const p = document.createElement("p");
  p.className = cls || "";
  p.textContent = text;
  return p;
}

// step 2: a domain of yours, a tunnel, or not now (a server answers by its IP: the Android app reaches it)
function showHow() {
  const p = phone.place;
  view("how");
  $("#howtitle").textContent = p.this ? "¿Dominio propio o túnel?" : `¿Dominio propio o túnel en ${p.name}?`;
  const box = $("#hows");
  box.innerHTML = "";
  box.append(card("Dominio propio", p.this ? "un dominio tuyo apuntando a esta computadora" : `un dominio tuyo apuntando a ${p.host}`,
    p.this ? "Solo si esta computadora recibe conexiones de internet en los puertos 80 y 443. En una casa casi nunca pasa: el router no las deja entrar." : "Atril saca el certificado; si ese servidor ya tiene un edge en el 443, se suma a él.",
    false, () => showDomain()));
  box.append(card("Túnel Synsema", "una dirección https fija, sin dominio ni puertos abiertos",
    p.this ? "Hace falta tu cuenta de Synsema en esta computadora (syn login)." : `Hace falta tu cuenta de Synsema en ${p.name} (syn login).`,
    false, () => run("tunnel")));
  if (!p.this) {
    box.append(card("Ahora no", `por la IP de ${p.host}`,
      "Funciona con la app de Android. Desde el navegador del teléfono hace falta dominio o túnel: lo agregás después con «cambiar».",
      false, () => run("ip")));
  }
}

// step 2b: which domain, and where it has to point
function showDomain() {
  const p = phone.place;
  view("domain");
  $("#pdomainhint").textContent = p.this
    ? "Creá un registro A de ese dominio con la IP pública de tu conexión, y en tu router mandá los puertos 80 y 443 a esta computadora."
    : `Creá un registro A de ese dominio que apunte a ${p.host}. Si ya existe, seguí.`;
  $("#pdomain").focus();
}
$("#pdomaingo").onclick = () => {
  const d = $("#pdomain").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) { $("#pdomainhint").textContent = "Escribí un dominio, por ejemplo relay.tudominio.com"; return; }
  run("domain", d);
};
$("#pdomain").onkeydown = (e) => { if (e.key === "Enter") $("#pdomaingo").click(); };

// step 3: Atril does it, and says what it is doing
function run(mode, domain) {
  phone.mode = mode;
  phone.domain = domain || "";
  const p = phone.place;
  view("work");
  $("#worktitle").textContent = mode === "synsema" ? "Usando el relay de Synsema" : p.this ? "Preparando el relay en esta computadora" : `Preparando el relay en ${p.name}`;
  $("#worklog").innerHTML = "";
  $("#workerr").hidden = true;
  $("#workbtns").hidden = true;
  $("#worklogin").hidden = true;
  $("#workspin").hidden = false;
  const ws = new WebSocket(WS + "/api/remote/setup");
  phone.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ place: p.id, mode, domain: phone.domain }));
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "step") { const li = document.createElement("li"); li.textContent = m.msg; $("#worklog").append(li); }
    else if (m.t === "login") {
      $("#loginurl").href = m.url;
      $("#loginurl").textContent = m.url;
      $("#logincode").textContent = m.code;
      $("#worklogin").hidden = false;
    } else if (m.t === "done") {
      phone.ws = null;
      $("#workspin").hidden = true;
      $("#worklogin").hidden = true;
      const r = m.result || {};
      if (r.ok) { showQr(await api("GET", "/api/remote/relay").catch(() => null)); return; }
      $("#workerr").textContent = r.error || "No se pudo.";
      $("#workerr").hidden = false;
      $("#workbtns").hidden = false;
    }
  };
  ws.onclose = () => { if (phone.ws === ws) { phone.ws = null; $("#workspin").hidden = true; $("#workerr").textContent = "Se cortó la conexión con Atril."; $("#workerr").hidden = false; $("#workbtns").hidden = false; } };
}
$("#workretry").onclick = () => run(phone.mode, phone.domain);
for (const b of document.querySelectorAll("#cphone .back")) b.onclick = () => {
  const v = b.closest(".pv").id;
  if (v === "pv-domain") showHow();
  else if (v === "pv-work" && phone.mode === "domain") showDomain();
  else if (v === "pv-work" && phone.place && phone.place.id !== "synsema") showHow();
  else showPlaces();
};
$("#loginopen").onclick = () => window.open($("#loginurl").href, "_blank", "noopener");

// step 4: the QR, the phones, and where the relay runs (measured from here)
const MODE = { ip: "por IP", domain: "dominio", tunnel: "túnel", synsema: "" };
function showQr(r) {
  view("qr");
  const s = (r && r.setup) || {};
  const host = r ? r.relay.replace(/^wss?:\/\//, "") : "";
  const where = s.place === "synsema" ? "Relay de Synsema" : s.place === "local" ? "Relay en esta computadora" : `Relay en ${s.name}`;
  const ms = r && r.probe && r.probe.ok && r.probe.ms != null ? ` · un mensaje va y vuelve en ${r.probe.ms} ms` : r && r.probe && !r.probe.ok ? " · no responde ahora" : "";
  // the relay's address on its own: in presentation mode it is blurred like the QR (it leads to your server)
  $("#relaynow").replaceChildren(`${where}${MODE[s.mode] ? " (" + MODE[s.mode] + ")" : ""} · `, Object.assign(document.createElement("span"), { id: "relayhost", textContent: host }), ms);
  $("#relaynow").className = r && r.probe && !r.probe.ok ? "warn" : "muted";
  $("#qripnote").hidden = s.mode !== "ip";
  newCode();
  paintPhones();
  phone.poll = setInterval(paintPhones, 2000);
}
// the phones that are not connected right now keep the old address: they will need a new code
const pairedCount = () => $("#phones").querySelectorAll("button").length;
$("#relaychg").onclick = async () => {
  if (pairedCount()) {
    const ok = await ask("¿Cambiar el relay?\nLos teléfonos conectados ahora se pasan solos. Uno que esté apagado o sin conexión en este momento va a tener que escanear un código nuevo.\nEl relay de ahora se apaga cuando el nuevo funcione.",
      [{ label: "Cancelar", value: false }, { label: "Cambiar", value: true, kind: "primary" }]);
    if (!ok) return;
  }
  phoneStop();
  showPlaces();
};
$("#relayoff").onclick = async () => {
  const ok = await ask("¿Quitar el relay?\nAtril lo apaga (y su túnel o su dominio, si tiene). " + (pairedCount() ? "Tus teléfonos siguen emparejados pero no pueden conectarse hasta que elijas otro relay, y van a tener que escanear un código nuevo." : "Para conectar un teléfono vas a tener que elegir otro."),
    [{ label: "Cancelar", value: false }, { label: "Quitar relay", value: true, kind: "danger" }]);
  if (!ok) return;
  phoneStop();
  view("places");
  $("#places").innerHTML = '<p class="loading">Apagando el relay…</p>';
  await api("POST", "/api/remote/relay/remove").catch(() => {});
  showPlaces();
};
async function newCode() {
  clearInterval(phone.timer);
  $("#qrmsg").textContent = "";
  $("#qrmsg").className = "";
  $("#qrbox").className = "";
  $("#qrbox").innerHTML = "";
  $("#qrexp").textContent = "Generando…";
  try {
    const known = await api("GET", "/api/remote/devices");
    phone.known = new Set(known.devices.map((d) => d.id));
    const p = await api("POST", "/api/remote/pair");
    $("#qrbox").innerHTML = p.svg;
    const end = Date.now() + p.expires_in * 1000;
    const tick = () => {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      if (left > 0) { $("#qrexp").textContent = `Sirve una vez. Vence en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`; return; }
      clearInterval(phone.timer);
      $("#qrbox").className = "used";
      $("#qrexp").textContent = "Este código venció.";
    };
    tick();
    phone.timer = setInterval(tick, 1000);
  } catch (e) { $("#qrexp").textContent = "No se pudo generar el código: " + e.message; }
}
async function paintPhones() {
  let r;
  try { r = await api("GET", "/api/remote/devices"); } catch { return; }
  const ul = $("#phones");
  ul.innerHTML = "";
  if (!r.devices.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Ninguno todavía.";
    ul.append(li);
  }
  for (const d of r.devices) {
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.textContent = d.name;
    const w = document.createElement("span");
    w.className = "muted";
    w.textContent = ` · emparejado hace ${ago(d.created)} · último uso hace ${ago(d.last)}`;
    const x = document.createElement("button");
    x.className = "mini danger";
    x.textContent = "quitar";
    x.onclick = async () => {
      const ok = await ask(`¿Quitar ${d.name}?\nSi está conectado se corta ahora, y no puede volver a entrar sin un código nuevo.`,
        [{ label: "Cancelar", value: false }, { label: "Quitar", value: true, kind: "danger" }]);
      if (!ok) return;
      await api("POST", `/api/remote/devices/${encodeURIComponent(d.id)}/remove`).catch(() => {});
      paintPhones();
    };
    li.append(n, w, x);
    ul.append(li);
  }
  // a new phone came in with this code: it is used
  const fresh = phone.known && r.devices.find((d) => !phone.known.has(d.id));
  if (fresh) {
    phone.known.add(fresh.id);
    clearInterval(phone.timer);
    $("#qrbox").className = "used";
    $("#qrexp").textContent = "";
    $("#qrmsg").className = "ok";
    $("#qrmsg").textContent = `Listo: ${fresh.name} quedó emparejado.`;
  }
}
$("#qrnew").onclick = newCode;
$("#pclose").onclick = closeConnect;


// ---- Atril's dialogs: ask() gives the value of the button pressed, or null (Esc, a click outside)
function ask(text, buttons) {
  return new Promise((resolve) => {
    const box = $("#dialog");
    $("#dtext").textContent = text;
    const row = $("#dbtns");
    row.innerHTML = "";
    const done = (v) => { box.hidden = true; document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.textContent = b.label;
      if (b.kind) el.className = b.kind;
      el.onclick = () => done(b.value);
      row.append(el);
    }
    box.onclick = (e) => { if (e.target === box) done(null); };
    document.addEventListener("keydown", onKey, true);
    box.hidden = false;
    (row.querySelector(".primary, .danger") || row.lastChild).focus();
  });
}
const notice = (text) => ask(text, [{ label: "Entendido", value: true, kind: "primary" }]);

async function forgetSpace(sp) {
  const running = inSpace(sp.sid).filter((s) => s.status === "running");
  let stop = false;
  if (running.length) {
    const names = running.map((s) => `${untitled(s) && isAgent(s) ? s.kind : s.name} (pid ${s.pid}${hidden.has(s.key) ? ", pestaña cerrada" : ""})`).join(", ");
    const v = await ask(`En ${sp.name} todavía corre: ${names}.

Si olvidás el space, eso se termina.`,
      [{ label: "Cancelar", value: false }, { label: "Ver", value: "show" }, { label: "Terminar y olvidar", value: true, kind: "danger" }]);
    if (v === "show") { reveal(running[0].key); return; }
    if (!v) return;
    stop = true;
    // one by one: every Atril understands this, also an older one on another machine
    for (const s of running) await api("POST", `${base(s.mid)}/sessions/${s.id}/kill`).catch(() => {});
    for (let i = 0; i < 40 && inSpace(sp.sid).some((s) => s.status === "running"); i++) await new Promise((r) => setTimeout(r, 200));
    if (inSpace(sp.sid).some((s) => s.status === "running")) {
      const mm = machineOf(sp.mid);
      const old = sp.mid !== LOCAL && mm && mm.version !== myVersion;
      await notice(old
        ? `No pude terminar lo que corre en ${sp.name}: ${machineName(mm)} tiene un Atril más viejo (${mm.version || "?"}), que no termina las shells de Linux.
Actualizalo con clic derecho en su pestaña → Actualizar Atril ahí, y volvé a probar.`
        : `Lo que corre en ${sp.name} no terminó. Probá de nuevo en unos segundos.`);
      return;
    }
  } else {
    const v = await ask(`¿Olvidar ${sp.name}?
Sólo deja de aparecer acá: la carpeta no se toca.`,
      [{ label: "Cancelar", value: false }, { label: "Olvidar", value: true, kind: "primary" }]);
    if (!v) return;
  }
  await api("POST", base(sp.mid) + "/spaces/forget", { key: sp.key, stop });
  for (const s of inSpace(sp.sid)) {
    dropTerm(s.key);
    if (s.status !== "running") api("DELETE", `${base(s.mid)}/sessions/${s.id}`).catch(() => {});
    sessions.delete(s.key);
  }
  if (current === sp.sid) { current = null; store.set("space2", null); }
  spacesBy[sp.mid] = (spacesBy[sp.mid] || []).filter((x) => x.key !== sp.key);
  renderSide();
}

// install this computer's Atril on a connected machine again; the dialog of "connect" shows the steps
async function updateMachine(mm) {
  const ok = await ask(`¿Actualizar Atril en ${machineName(mm)} a la versión de esta computadora (${myVersion})?\nLo que corre en Atril allá se cierra; los spaces quedan.`,
    [{ label: "Cancelar", value: false }, { label: "Actualizar", value: true, kind: "primary" }]);
  if (!ok) return;
  openConnect("ssh");
  $("#cgo").hidden = true;
  working(true);
  logLine(`Actualizando Atril en ${machineName(mm)}…`);
  const ws = new WebSocket(WS + `/api/machines/${encodeURIComponent(mm.mid)}/update`);
  connWs = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "step") logLine(m.msg);
    else if (m.t === "done") {
      working(false);
      const r = m.result || {};
      if (r.ok) { logLine("Listo: actualizado. Reconectando.", "ok"); setTimeout(closeConnect, 1500); }
      else logLine(r.error || "No se pudo actualizar.", "err");
      connWs = null;
    }
  };
  ws.onclose = () => { if (connWs === ws) { logLine("Se cortó la conexión con Atril.", "err"); working(false); connWs = null; } };
}

// ---- context menus
let ctxKey = null;
let ctxSpace = null;
let ctxMachine = null;
function place(m, x, y) {
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - 220) + "px";
  m.style.top = Math.min(y, innerHeight - 160) + "px";
}
function only(kind) { for (const b of $("#ctx").querySelectorAll("button")) b.hidden = (b.dataset.for || "session") !== kind; }
function showCtx(key, x, y) {
  ctxKey = key;
  const m = $("#ctx");
  const s = sessions.get(key);
  only("session");
  m.querySelector('[data-a="kill"]').hidden = s.status !== "running";
  m.querySelector('[data-a="kill"]').textContent = "Terminar proceso";
  m.querySelector('[data-a="remove"]').hidden = s.status === "running";
  m.querySelector('[data-a="restart"]').hidden = s.status === "running";
  m.querySelector('[data-a="toboard"]').hidden = boardOn() && BOARD.keys.includes(key);
  m.querySelector('[data-a="offboard"]').hidden = !(boardOn() && BOARD.keys.includes(key));
  place(m, x, y);
}
function showSpaceMenu(sp, x, y) { ctxSpace = sp; only("space"); place($("#ctx"), x, y); }
function showMachineMenu(mm, x, y) {
  ctxMachine = mm;
  only("machine");
  const m = $("#ctx");
  m.querySelector('[data-a="reconnect"]').hidden = mm.mid === LOCAL;
  m.querySelector('[data-a="unlink"]').hidden = mm.mid === LOCAL;
  m.querySelector('[data-a="update"]').hidden = mm.mid === LOCAL || mm.status !== "up";
  m.querySelector('[data-a="mnew"]').hidden = mm.status !== "up";
  place(m, x, y);
}
document.addEventListener("click", (e) => { if (!e.target.closest("#ctx")) $("#ctx").hidden = true; });
$("#ctx").onclick = async (e) => {
  const a = e.target.dataset.a;
  if (!a) return;
  $("#ctx").hidden = true;
  try {
    if (a === "forget") return await forgetSpace(ctxSpace);
    if (a === "sptoboard") return await boardAddSpace(ctxSpace);
    if (a === "newtab") { current = ctxSpace.sid; store.set("space2", current); renderSide(); return askTitle(); }
    if (a === "mnew") return openPicker(ctxMachine.mid);
    if (a === "alias") return openPresent(ctxMachine.mid);
    if (a === "reconnect") return api("POST", `/api/machines/${ctxMachine.mid}/reconnect`);
    if (a === "update") return updateMachine(ctxMachine);
    if (a === "unlink") {
      const ok = await ask(`¿Desconectar ${ctxMachine.name}?\nLo que corre allá sigue corriendo; sólo deja de verse acá.`,
        [{ label: "Cancelar", value: false }, { label: "Desconectar", value: true, kind: "danger" }]);
      if (!ok) return;
      return api("POST", `/api/machines/${ctxMachine.mid}/forget`);
    }
    const s = sessions.get(ctxKey);
    if (a === "open") reveal(ctxKey);
    if (a === "rename") { reveal(ctxKey); setTimeout(() => renameTab(ctxKey), 50); }
    if (a === "kill") {
      const ok = await ask(`¿Terminar ${untitled(s) && isAgent(s) ? s.kind : s.name} (pid ${s.pid})?\nEl programa se cierra.`,
        [{ label: "Cancelar", value: false }, { label: "Terminar", value: true, kind: "danger" }]);
      if (ok) await api("POST", `${base(s.mid)}/sessions/${s.id}/kill`);
    }
    if (a === "restart") await restart(ctxKey);
    if (a === "remove") closeTab(ctxKey);
    if (a === "toboard") boardAdd(ctxKey);
    if (a === "offboard") boardRemove(ctxKey);
  } catch (err) { notice(err.message); }
};

// ---- keys
// a key in a terminal reaches here twice: from xterm's own handler, and again from the document's as it
// bubbles up. Once is enough: a toggle (the files panel, the sidebar, presentation) would undo itself
function shortcuts(e) {
  if (e.atrilSeen === undefined) e.atrilSeen = shortcutsOnce(e);
  return e.atrilSeen;
}
function shortcutsOnce(e) {
  if (e.type !== "keydown") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyK") { openPalette(); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyT") { if (boardOn()) boardNewHere(); else askTitle(); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") { if (boardOn()) { if (BOARD.focus) boardRemove(BOARD.focus); } else if (lastTab[current]) closeTab(lastTab[current]); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") { setSide($("#side").classList.contains("collapsed")); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyE") { setFiles(!FILES.open); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyP") { setPresent(!PRESENT.on); return false; }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyD") { boardToggle(); return false; }   // board.js: in and out
  if (e.ctrlKey && e.code === "Tab") {
    if (boardOn()) { boardCycle(e.shiftKey ? -1 : 1); return false; }
    const keys = tabsOf(current).map((s) => s.key);
    if (keys.length) focusTab(keys[(keys.indexOf(lastTab[current]) + (e.shiftKey ? -1 : 1) + keys.length) % keys.length]);
    return false;
  }
  return true;
}
document.addEventListener("keydown", (e) => { if (!shortcuts(e)) e.preventDefault(); });

const KEYS = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", ctrlc: "\x03" };
function setCtrl(t, on) { t.ctrl = on; $('#keys [data-k="ctrl"]').classList.toggle("on", on); }
$("#keys").onclick = (e) => {
  const k = e.target.dataset.k;
  const t = terms.get(activeKey());
  if (!k || !t) return;
  if (k === "ctrl") setCtrl(t, !t.ctrl); else send(t, { t: "i", d: KEYS[k] });
  t.term.focus();
};

function setSide(open) {
  $("#side").classList.toggle("collapsed", !open);
  $("#expand").hidden = open;
  store.set("side", open);
  requestAnimationFrame(() => { const t = terms.get(activeKey()); if (t) t.fit.fit(); });
}
$("#collapse").onclick = () => setSide(false);
$("#expand").onclick = () => setSide(true);
setSide(store.get("side", true));

$("#plus").onclick = () => (boardOn() ? openPalette() : askTitle());   // on the board: add a terminal
$("#open-term").onclick = () => newTab().catch((err) => notice(err.message));
// with no terminal on screen, Enter or + open one (inside a terminal they are just keys)
document.addEventListener("keydown", (e) => {
  if ($("#empty").hidden || e.ctrlKey || e.altKey || e.metaKey) return;
  // a key typed into a field (a title, a search) is that field's
  if (/INPUT|TEXTAREA/.test(e.target.tagName) || (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) return;
  if (!$("#palette").hidden || !$("#picker").hidden || !$("#conn").hidden || !$("#dialog").hidden || !$("#viewer").hidden) return;
  if (e.key === "Enter" || e.key === "+") { e.preventDefault(); newTab().catch((err) => notice(err.message)); }
});
$("#new").onclick = () => openPicker();
$("#adddev").onclick = () => openConnect("phone");
$("#find").onclick = openPalette;
$("#menu").onclick = () => $("#side").classList.toggle("show");
$("#stage").onclick = () => $("#side").classList.remove("show");
// a tap anywhere outside the open sidebar (the tabs, the shade over the terminal) closes it
document.addEventListener("click", (e) => {
  const side = $("#side");
  if (side.classList.contains("show") && !side.contains(e.target) && !$("#menu").contains(e.target)) side.classList.remove("show");
}, true);

// ---- start
(async () => {
  if (!(await login())) {
    document.body.innerHTML = `<p style="padding:40px;color:#9a9aa2">Abrí Atril con <b style="color:#e6e6ea">atr open</b>: trae la llave de esta computadora.</p>`;
    return;
  }
  initThemes();
  setTimeout(initStar, 20000);   // not while the window is still opening
  feed(LOCAL);
  // the first lists arrive on the events socket; then show what was asked, or the last space
  const ready = setInterval(() => {
    if (!spacesBy[LOCAL]) return;
    clearInterval(ready);
    if (wanted) show(wanted);
    else if (boardOn()) enterBoard();   // as you left it
    else if (spaceOf(current)) selectSpace(current);
    else if (spacesBy[LOCAL].length) selectSpace(spaceId(LOCAL, spacesBy[LOCAL][0].key));
  }, 100);
})();
