// board.js — the tablero: up to four terminals on screen at once, from any space of any device.
//
// The screen has two modes, never both (app.js header):
//   space mode (app.js, as always): one space selected, its tabs on top, one terminal.
//   board mode (this file): no space selected; the board's terminals side by side, by how many:
//        1: [ a ]     2: [a][b]     3: [a][b]     4: [a][b]
//                                     [ c  ]       [c][d]
// The board is a list of session keys ("mid/id"), so each pane can be on another machine. A terminal
// is the same xterm in both modes (terms, in app.js): entering the board moves its element into a
// pane, leaving moves it back to #stage. Nothing here starts or ends a program except boardNew, which
// opens a terminal: taking one off the board leaves it running, as a tab of its space.
//
// Atril is space mode first: the board stays out of sight until you ask for it. «tablero» in the
// sidebar shows only while the board has terminals (or is on screen), and going from a space into the
// board asks once what it is (boardAsk: every way in goes through it, until «no volver a preguntar»).
// How you get here: hold a tab still (it comes off the bar), Ctrl+Shift+D, drag a tab, a space or an
// agent onto the terminal, right click → «Llevar al tablero», or «tablero» once there is a board.
// How you leave: «salir» (the board stays as it was for the next time, in localStorage), «cerrar
// tablero» (emptied), Ctrl+Shift+D, ↗ on a pane (to its space), or choosing a space or an agent that
// is not on the board. A board of one terminal or none is not kept: it is only a tab (leaveBoard).
//
// What app.js calls here (keep these names): BOARD, BOARD_MAX, renderBoard, paintBoardBtn,
// enterBoard, leaveBoard, boardFocus, boardAdd, boardAddSpace, boardNew, boardNewHere, boardRemove,
// boardReplace, boardCycle, boardDraggable, boardHold. Uses from app.js: $, store, sessions, terms,
// makeTerm, showOnly, renderSide, reveal, selectSpace, newTab, tabsOf, lastTab, current, spaceOf,
// spaceId, machineOf, machineName, machines, loaded, unseen, notice, showCtx, openPalette, dotOf,
// untitled, isAgent, tooltip, LOCAL.
"use strict";

const BOARD_MAX = 4;
const BOARD = {
  on: store.get("boardOn", false),
  keys: store.get("board", []).slice(0, BOARD_MAX),   // session keys, in the order of the panes
  focus: store.get("boardFocus", null),                // the pane your keys go to
};
const panes = new Map();   // key -> its pane, only while the board is on screen
const boardSave = () => { store.set("boardOn", BOARD.on); store.set("board", BOARD.keys); store.set("boardFocus", BOARD.focus); };

// the layout as a small drawing: what the board looks like with n terminals
function layoutIcon(n) {
  const r = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1"/>`;
  const cells = n <= 1 ? r(1, 1, 14, 12)
    : n === 2 ? r(1, 1, 6.5, 12) + r(8.5, 1, 6.5, 12)
    : n === 3 ? r(1, 1, 6.5, 5.5) + r(8.5, 1, 6.5, 5.5) + r(1, 7.5, 14, 5.5)
    : r(1, 1, 6.5, 5.5) + r(8.5, 1, 6.5, 5.5) + r(1, 7.5, 6.5, 5.5) + r(8.5, 7.5, 6.5, 5.5);
  return `<svg class="lay" width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.3">${cells}</svg>`;
}

// ---- what a pane says: the device, the space (and its branch) and the terminal
function paneName(s) { return untitled(s) ? (isAgent(s) ? s.kind : "terminal") : s.name; }
function paneWhere(key) {
  const s = sessions.get(key);
  const mm = machineOf(key.slice(0, key.indexOf("/")));
  const sp = s && spaceOf(spaceId(s.mid, s.space));
  return { s, mm, sp, dev: mm ? machineName(mm) : "?" };
}
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };   // present.js masks every change: only real ones

// ---- the board on screen. app.js calls this instead of drawing the tabs whenever the sidebar is drawn
function renderBoard() {
  boardPrune();
  $("#app").classList.add("boarding");
  $("#board").hidden = false;
  $("#empty").hidden = true;
  for (const k of [...panes.keys()]) if (!BOARD.keys.includes(k)) unpane(k);
  if (!BOARD.keys.includes(BOARD.focus)) BOARD.focus = BOARD.keys[0] || null;
  $("#board").className = "n" + BOARD.keys.length;
  BOARD.keys.forEach((k, i) => {
    const p = panes.get(k) || makePane(k);
    p.style.gridArea = "p" + i;
    p.classList.toggle("focus", k === BOARD.focus);
    paintHead(p, k);
    const s = sessions.get(k);
    p.querySelector(".bwait").hidden = !!s;
    if (!s) return;
    const t = terms.get(k) || makeTerm(s);
    if (t.el.parentNode !== p.body) p.body.append(t.el);
    t.el.hidden = false;
  });
  $("#bempty").hidden = BOARD.keys.length > 0;
  paintBar();
  document.title = "Atril · tablero";
}

// a terminal that ended and was removed, or whose machine you disconnected, leaves the board; one on a
// machine that has not answered yet waits in its pane
function boardPrune() {
  if (!loaded.has(LOCAL)) return;   // the machines are not known yet
  const keep = BOARD.keys.filter((k) => {
    const mid = k.slice(0, k.indexOf("/"));
    if (!machineOf(mid)) return false;
    return sessions.has(k) || !loaded.has(mid);
  });
  if (keep.length !== BOARD.keys.length) { BOARD.keys = keep; boardSave(); }
}

// each pane's terminal fits its pane: when the layout changes, the window, the sidebar
const fitter = new ResizeObserver((entries) => requestAnimationFrame(() => {
  if (!BOARD.on) return;
  for (const e of entries) {
    const t = terms.get(e.target.parentNode && e.target.parentNode.dataset.key);
    if (t && e.target.contains(t.el) && e.contentRect.width > 0 && e.contentRect.height > 0) t.fit.fit();
  }
}));

function makePane(k) {
  const p = document.createElement("div");
  p.className = "pane";
  p.dataset.key = k;
  p.innerHTML = `<div class="bh"><span class="st"></span><span class="bdev"></span><span class="bsp"></span><span class="bt"></span>`
    + `<button class="bgo" title="Ir a su space (sale del tablero)">↗</button>`
    + `<button class="bx" title="Sacar del tablero: el programa sigue corriendo, como pestaña de su space">×</button></div>`
    + `<div class="bb"><p class="bwait"></p></div>`;
  p.body = p.querySelector(".bb");
  // capture: before xterm takes the click, the pane becomes the one your keys go to
  p.addEventListener("pointerdown", () => boardFocus(k, false), true);
  p.addEventListener("focusin", () => boardFocus(k, false));
  p.querySelector(".bx").onclick = (e) => { e.stopPropagation(); boardRemove(k); };
  p.querySelector(".bgo").onclick = (e) => { e.stopPropagation(); reveal(k); };
  const head = p.querySelector(".bh");
  head.oncontextmenu = (e) => { e.preventDefault(); if (sessions.has(k)) showCtx(k, e.clientX, e.clientY); };
  boardDraggable(head, { pane: k });   // dragged onto another pane, the two swap places
  fitter.observe(p.body);
  $("#board").append(p);
  panes.set(k, p);
  return p;
}

function paintHead(p, k) {
  const { s, mm, sp, dev } = paneWhere(k);
  setText(p.querySelector(".bdev"), dev);
  setText(p.querySelector(".bsp"), sp ? sp.name + (sp.branch ? " · " + sp.branch : "") : "");
  setText(p.querySelector(".bt"), s ? paneName(s) : "");
  p.querySelector(".st").className = "st " + (s ? dotOf(s) : "none");
  const title = s ? tooltip(s) : "";
  if (p.querySelector(".bh").title !== title) p.querySelector(".bh").title = title;
  const wait = mm && mm.status !== "up" ? `esperando a ${dev}: sin conexión, reintentando…` : `esperando a ${dev}…`;
  setText(p.querySelector(".bwait"), wait);
}

// its terminal back to the stage, hidden, as a tab of its space; the pane goes
function unpane(k) {
  const p = panes.get(k);
  if (!p) return;
  const t = terms.get(k);
  if (t && t.el.parentNode === p.body) { t.el.hidden = true; $("#stage").append(t.el); }
  fitter.unobserve(p.body);
  p.remove();
  panes.delete(k);
}

// the bar on top, instead of the tabs: one chip per pane (on a phone, where only one pane fits, they
// switch between them), + agregar, and the way out
function paintBar() {
  const bar = $("#tablist");
  bar.innerHTML = "";
  // «tablero» on a computer; on a phone how many there are, and a click lists them to choose one
  const head = document.createElement("button");
  head.className = "btitle";
  head.innerHTML = `${layoutIcon(BOARD.keys.length)}<span class="bl">tablero</span><span class="bn">${BOARD.keys.length}</span><span class="bc">▾</span>`;
  head.title = `Hasta ${BOARD_MAX} terminales de cualquier space y dispositivo: clic para elegir una. Arrastrá la barra de un panel para cambiarlo de lugar.`;
  head.onclick = (e) => { e.stopPropagation(); paneMenu(head); };
  bar.append(head);
  for (const k of BOARD.keys) {
    const { s, sp, dev } = paneWhere(k);
    const el = document.createElement("div");
    el.className = "tab" + (k === BOARD.focus ? " on" : "");
    el.dataset.key = k;
    el.innerHTML = `<span class="st ${s ? dotOf(s) : "none"}"></span><span class="t"></span><button class="x">×</button>`;
    // which one it is at a glance: its space (and its device, when it is not this one) and its name
    el.querySelector(".t").textContent = [k.startsWith(LOCAL + "/") ? "" : dev, sp ? sp.name : "", s ? paneName(s) : ""].filter(Boolean).join(" · ") || dev;
    el.title = s ? tooltip(s) : dev;
    el.querySelector(".x").title = "Sacar del tablero (el programa sigue)";
    el.onclick = (e) => { if (!e.target.closest(".x")) boardFocus(k); };
    el.querySelector(".x").onclick = () => boardRemove(k);
    el.oncontextmenu = (e) => { e.preventDefault(); if (s) showCtx(k, e.clientX, e.clientY); };
    bar.append(el);
  }
  const plus = $("#plus");
  plus.querySelector(".lbl").textContent = " agregar";
  plus.title = BOARD.keys.length >= BOARD_MAX
    ? `El tablero tiene ${BOARD_MAX} terminales: sacá una para sumar otra`
    : "Sumar al tablero una terminal que ya corre, o una nueva en cualquier space y dispositivo (Ctrl+Shift+T: una nueva junto a la que tenés en foco)";
  plus.classList.toggle("full", BOARD.keys.length >= BOARD_MAX);
  $("#boardx").hidden = false;
  $("#boardclose").hidden = false;
}

// the board's terminals in a list under its title: the one chosen comes to the front (on a phone, where
// one pane fits, the way to move between them)
function paneMenu(anchor) {
  const m = $("#bmenu");
  if (!m.hidden) { m.hidden = true; return; }
  m.innerHTML = "";
  for (const k of BOARD.keys) {
    const { s, sp, dev } = paneWhere(k);
    const b = document.createElement("button");
    b.className = k === BOARD.focus ? "on" : "";
    b.innerHTML = `<span class="st ${s ? dotOf(s) : "none"}"></span><span class="bmn"></span><span class="bmw"></span>`;
    b.querySelector(".bmn").textContent = s ? paneName(s) : dev;
    b.querySelector(".bmw").textContent = [dev, sp ? sp.name + (sp.branch ? " · " + sp.branch : "") : ""].filter(Boolean).join(" · ");
    b.onclick = () => { m.hidden = true; boardFocus(k); };
    m.append(b);
  }
  if (!BOARD.keys.length) m.innerHTML = `<p class="muted">El tablero está vacío: «+» suma una terminal.</p>`;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - 300)) + "px";
  m.style.top = r.bottom + 4 + "px";
  m.hidden = false;
}
document.addEventListener("click", (e) => { if (!e.target.closest("#bmenu")) $("#bmenu").hidden = true; });

// the sidebar's «tablero»: the way in and out, and where a tab, a space or an agent can be dropped
function paintBoardBtn() {
  const b = $("#boardbtn");
  const n = BOARD.keys.length;
  b.hidden = !BOARD.on && !n;   // no board, no button: Atril looks as it always did
  b.classList.toggle("on", BOARD.on);
  b.innerHTML = `${layoutIcon(n)}<span>tablero</span><span class="muted">${n ? n + "/" + BOARD_MAX : ""}</span>`;
  b.title = BOARD.on ? "Volver a los spaces (el tablero queda armado)"
    : `Volver al tablero (Ctrl+Shift+D): varias terminales a la vez, de distintos spaces y dispositivos (hasta ${BOARD_MAX}).`;
}

// ---- in and out
function enterBoard(focus) {
  if (!BOARD.on) {
    BOARD.on = true;
    if (typeof VIEW !== "undefined" && VIEW) minimizeViewer(false);   // the file waits in its space
  }
  if (focus) BOARD.focus = focus;
  boardSave();
  showOnly(null);   // the space's terminal leaves the stage; the board's come into their panes
  $("#side").classList.remove("show");
  renderSide();
  const t = terms.get(BOARD.focus);
  if (t) requestAnimationFrame(() => t.term.focus());
}
function leaveBoard() {
  if (!BOARD.on) return;
  BOARD.on = false;
  if (BOARD.keys.length <= 1) BOARD.keys = [];   // one terminal is a tab, not a board: nothing to come back to
  boardSave();
  for (const k of [...panes.keys()]) unpane(k);
  $("#board").hidden = true;
  $("#boardx").hidden = true;
  $("#boardclose").hidden = true;
  $("#bmenu").hidden = true;
  $("#app").classList.remove("boarding");
  $("#plus").querySelector(".lbl").textContent = " terminal";
  $("#plus").title = "Nueva terminal en este space (Ctrl+Shift+T)";
  $("#plus").classList.remove("full");
}
// out to where the focused pane lives: its space, with its tab on screen
function exitBoard() {
  const k = BOARD.focus;
  leaveBoard();
  if (k && sessions.has(k)) reveal(k);
  else selectSpace(current);
}
// «cerrar tablero»: emptied and out; its terminals keep running, each one a tab of its space
function closeBoard() {
  const k = BOARD.focus;
  BOARD.keys = [];
  leaveBoard();
  if (k && sessions.has(k)) reveal(k);
  else selectSpace(current);
}
$("#boardx").onclick = exitBoard;
$("#boardclose").onclick = closeBoard;
$("#boardbtn").onclick = () => { if (BOARD.on) exitBoard(); else enterBoard(); };

// ---- the board's terminals
function boardFocus(k, focusTerm = true) {
  if (!BOARD.keys.includes(k)) return;
  if (BOARD.focus !== k) {
    BOARD.focus = k;
    store.set("boardFocus", k);
    for (const [pk, p] of panes) p.classList.toggle("focus", pk === k);
    for (const c of $("#tablist").querySelectorAll(".tab")) c.classList.toggle("on", c.dataset.key === k);
  }
  if (unseen.delete(k)) renderSide();   // an agent that finished, seen now
  const t = terms.get(k);
  if (t && focusTerm) requestAnimationFrame(() => t.term.focus());
}
function boardCycle(dir) {
  const ks = BOARD.keys;
  if (ks.length) boardFocus(ks[(ks.indexOf(BOARD.focus) + dir + ks.length) % ks.length]);
}
function boardFull() {
  notice(`El tablero ya tiene ${BOARD_MAX} terminales. Sacá una (× en su barra) para sumar otra, o soltá la nueva encima de la que querés cambiar.`);
  if (!BOARD.on) enterBoard();
}
// from a space into the board: the first time, a word on what it is and a way back out. Gives whether
// to go on. A function that already asked passes asked = true to the next one, so one gesture asks once
async function boardAsk(asked = false) {
  if (asked || BOARD.on || store.get("boardAsked", false)) return true;
  const go = ask(`¿Armar un tablero con esta terminal?
Varias terminales a la vez (hasta ${BOARD_MAX}), de distintos spaces y dispositivos. Ningún space queda seleccionado; los programas siguen corriendo como siempre.
Para volver: «salir del tablero» o Ctrl+Shift+D.`,
    [{ label: "Cancelar", value: false }, { label: "Armar tablero", value: true, kind: "primary" }]);
  // ask() draws the text before it waits: the box below it is this dialog's own
  const box = document.createElement("label");
  box.className = "dcheck";
  box.innerHTML = `<input type="checkbox" checked> no volver a preguntar`;
  $("#dtext").append(box);
  const yes = await go;
  if (yes && box.querySelector("input").checked) store.set("boardAsked", true);
  return !!yes;
}
// Ctrl+Shift+D: into the board with the tab on screen (or the board as it was), and out again
async function boardToggle() {
  if (BOARD.on) return exitBoard();
  const k = BOARD.keys.length ? null : lastTab[current];
  if (!BOARD.keys.length && !k) return notice("Abrí una terminal primero: el tablero empieza con ella.");
  if (!(await boardAsk())) return;
  if (k) boardPlace(k, null, true); else enterBoard();
}
// a terminal onto the board, in place at (a pane's index: when the board is full it takes that pane's
// place) or after the last; one already there moves to at
async function boardPlace(key, at = null, asked = false) {
  if (!sessions.has(key)) return;
  if (!(await boardAsk(asked))) return;
  const ks = BOARD.keys;
  const i = ks.indexOf(key);
  if (i >= 0) { if (at != null && at < ks.length && at !== i) [ks[i], ks[at]] = [ks[at], ks[i]]; }
  else if (at == null || at >= ks.length) { if (ks.length >= BOARD_MAX) return boardFull(); ks.push(key); }
  else if (ks.length >= BOARD_MAX) ks[at] = key;
  else ks.splice(at, 0, key);
  enterBoard(key);
}
const boardAdd = (key) => boardPlace(key);
function boardRemove(key) {
  const i = BOARD.keys.indexOf(key);
  if (i < 0) return;
  BOARD.keys.splice(i, 1);
  if (BOARD.focus === key) BOARD.focus = BOARD.keys[Math.min(i, BOARD.keys.length - 1)] || null;
  boardSave();
  // the last one off: the board closes, back to the space of the terminal just taken off
  if (BOARD.on && !BOARD.keys.length) { leaveBoard(); if (sessions.has(key) && !hidden.has(key)) reveal(key); else selectSpace(current); return; }
  renderSide();
  const t = terms.get(BOARD.focus);
  if (BOARD.on && t) requestAnimationFrame(() => t.term.focus());
}
// a restarted terminal is a new session: it takes the place the old one had
function boardReplace(old, key, at) {
  BOARD.keys = BOARD.keys.filter((k) => k !== old);
  BOARD.keys.splice(Math.min(at, BOARD.keys.length), 0, key);
  BOARD.keys = BOARD.keys.slice(0, BOARD_MAX);
  BOARD.focus = key;
  boardSave();
  renderSide();
}
// a new terminal in a space of any device, straight onto the board
async function boardNew(sp, at = null, asked = false) {
  if (BOARD.keys.length >= BOARD_MAX && at == null) return boardFull();
  boardPlace(await newTab({ cwd: sp.path }, sp.mid, false), at, asked);
}
// Ctrl+Shift+T on the board: a new terminal beside the focused one, in its space; else choose where
function boardNewHere() {
  const s = sessions.get(BOARD.focus);
  const sp = s && spaceOf(spaceId(s.mid, s.space));
  if (sp) boardNew(sp).catch((err) => notice(err.message));
  else openPalette();
}
// a space onto the board: the terminal it showed last that is not there yet, else a new one
async function boardAddSpace(sp, at = null) {
  if (!sp || !(await boardAsk())) return;
  const open = tabsOf(sp.sid).filter((s) => !BOARD.keys.includes(s.key));
  const s = open.find((x) => x.key === lastTab[sp.sid]) || open[open.length - 1];
  if (s) return boardPlace(s.key, at, true);
  return boardNew(sp, at, true);
}

// ---- dragging: a tab, an agent, a space (into the board) or a pane's bar (to another place in it)
const DRAG = "application/x-atril";
const fine = matchMedia("(pointer: fine)").matches;   // a finger long-presses instead (the menu, or a held tab)
function boardDraggable(el, what) {
  if (!fine) return;
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    cancelHold();
    e.dataTransfer.setData(DRAG, JSON.stringify(what));
    e.dataTransfer.effectAllowed = "move";
    document.documentElement.classList.add("dragging");
  });
  el.addEventListener("dragend", dropDone);
}
const carrying = (e) => e.dataTransfer && [...e.dataTransfer.types].includes(DRAG);
function dropDone() {
  document.documentElement.classList.remove("dragging");
  $("#bdrop").hidden = true;
  $("#boardbtn").classList.remove("drop");
  for (const p of panes.values()) p.classList.remove("drop");
}
async function dropped(e, at) {
  e.preventDefault();
  dropDone();
  let what = null;
  try { what = JSON.parse(e.dataTransfer.getData(DRAG)); } catch {}
  if (!what) return;
  try {
    if (what.pane) { if (BOARD.on && at != null) boardPlace(what.pane, at); }
    else if (what.key) boardPlace(what.key, at);
    else if (what.sid) await boardAddSpace(spaceOf(what.sid), at);
  } catch (err) { notice(err.message); }
}
{
  const stage = $("#stage");
  stage.addEventListener("dragover", (e) => {
    if (!carrying(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!BOARD.on) {
      // space mode: the whole terminal says what letting go does
      const n = Math.min(BOARD.keys.length + 1, BOARD_MAX);
      const box = $("#bdrop");
      if (box.hidden) {
        box.innerHTML = `<div>${layoutIcon(n)}<b>Soltá para llevarla al tablero</b><span>${BOARD.keys.length ? `se suma a las ${BOARD.keys.length} que ya están` : "varias terminales a la vez, de distintos spaces y dispositivos"}</span></div>`;
        box.hidden = false;
      }
      return;
    }
    const p = e.target.closest(".pane");
    for (const x of panes.values()) x.classList.toggle("drop", x === p);
  });
  stage.addEventListener("dragleave", (e) => { if (!stage.contains(e.relatedTarget)) dropDone(); });
  stage.addEventListener("drop", (e) => {
    if (!carrying(e)) return;
    const p = BOARD.on && e.target.closest(".pane");
    dropped(e, p ? BOARD.keys.indexOf(p.dataset.key) : null);
  });
  const btn = $("#boardbtn");
  btn.addEventListener("dragover", (e) => { if (carrying(e)) { e.preventDefault(); btn.classList.add("drop"); } });
  btn.addEventListener("dragleave", () => btn.classList.remove("drop"));
  btn.addEventListener("drop", (e) => { if (carrying(e)) dropped(e, null); });
}

// ---- a tab held still comes off the bar: the board opens with it. Moving first is a drag, letting go
// first is a click; the click that ends the hold does not also choose the tab under it
const HOLD_MS = 450;
let hold = null;     // {el, key, x, y, timer}
let held = false;    // a hold fired and its pointer is still down
let releasedAt = 0;  // when the pointer of a hold that fired was let go
function boardHold(el, key) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input")) return;
    cancelHold();
    el.classList.add("holding");
    hold = { el, key, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      const h = hold;
      hold = null;
      held = true;
      h.el.classList.remove("holding");
      h.el.classList.add("lift");
      setTimeout(() => boardAdd(h.key), 160);
    }, HOLD_MS) };
  });
}
function cancelHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  hold.el.classList.remove("holding");
  hold = null;
}
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => { cancelHold(); if (held) { held = false; releasedAt = Date.now(); } }, true);
}
window.addEventListener("pointermove", (e) => {
  if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 6) cancelHold();
  // no pointer moves while something is dragged: one that moves means a drag ended without a drop
  // here (Esc, or its tab redrawn under it, which loses its dragend)
  if (document.documentElement.classList.contains("dragging")) dropDone();
}, true);
// what the hold itself sets off is swallowed: the menu a phone opens on a long press (while held, or as
// it is let go) and the click of letting go, which comes right after its pointerup. Not a later click:
// that one may be on the board's question, which shows up while the tab is still held
const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
document.addEventListener("contextmenu", (e) => { if (held || Date.now() - releasedAt < 300) swallow(e); }, true);
document.addEventListener("click", (e) => { if (Date.now() - releasedAt < 300) { releasedAt = 0; swallow(e); } }, true);

// the empty board says how to fill it
$("#bempty").innerHTML = `<div>${layoutIcon(4)}<p><b>El tablero está vacío.</b></p>
  <p class="muted">Hasta ${BOARD_MAX} terminales a la vez, de cualquier space y de cualquier dispositivo.</p>
  <p class="muted">Arrastrá hasta acá una pestaña, un space o un agent, o usá <b>+ agregar</b>.<br>
  Desde un space: mantené apretada una pestaña, Ctrl+Shift+D, o clic derecho → Llevar al tablero.</p></div>`;
