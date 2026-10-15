// present.js — presentation mode, to record or share the screen: what is yours (your user, your email,
// your machines and whatever you add) is covered with dots wherever this window shows it. In the
// terminals the dots have the same length as the word, so a program that lays itself out by columns
// (an agent's screen) stays as it was; what a program receives and does is not touched, only what is
// drawn here. Machines can have a name of your own (always, not only while presenting). A file that
// usually holds secrets (.env, keys) asks before it opens. The pairing QR stays blurred until clicked.
// Uses app.js: $, api, store, machines, machineOf, sessions, terms, connect, renderSide, LOCAL, base.
"use strict";

const PRESENT = {
  on: store.get("present", false),
  words: store.get("presentWords", null),   // null: never set, filled from what this machine says is yours
};
let MASK_RE = null, MASK_MAX = 0;
const MIN_WORD = 3;                          // a shorter word would cover too much
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildMask() {
  const ws = [...new Set((PRESENT.words || []).map((w) => String(w).trim()).filter((w) => w.length >= MIN_WORD))]
    .sort((a, b) => b.length - a.length);
  MASK_RE = ws.length ? new RegExp(ws.map(escRe).join("|"), "gi") : null;
  MASK_MAX = ws.reduce((m, w) => Math.max(m, w.length), 0);
}
const dots = (m) => "•".repeat([...m].length);
// the window's own "pid 1234" too (the sidebar, tooltips, dialogs): a number that says nothing outside,
// but this mode promised a window without them
const PID_RE = /\bpid (\d+)/g;
const maskText = (s) => {
  if (!PRESENT.on || !s) return s;
  const v = String(s).replace(PID_RE, (m, n) => "pid " + dots(n));
  return MASK_RE ? v.replace(MASK_RE, dots) : v;
};

// ---- the terminals: what a session prints goes through here before xterm draws it. The end of a
// chunk that could be the beginning of a word waits for the next one (40 ms at most), so a word cut in
// two by the pipe is still covered whole
function maskWrite(t, d, done) {
  if (!PRESENT.on || !MASK_RE) {
    if (t.mpend) { const p = t.mpend; t.mpend = ""; t.term.write(p); }
    return done ? t.term.write(d, done) : t.term.write(d);
  }
  clearTimeout(t.mtimer);
  let s = ((t.mpend || "") + d).replace(MASK_RE, dots);
  t.mpend = "";
  const keep = heldTail(s);
  if (keep) {
    t.mpend = s.slice(-keep);
    s = s.slice(0, -keep);
    t.mtimer = setTimeout(() => { const p = t.mpend; t.mpend = ""; if (p) t.term.write(p); }, 40);
  }
  if (done) t.term.write(s, done); else if (s) t.term.write(s);
}
function heldTail(s) {
  const low = s.slice(-(MASK_MAX - 1)).toLowerCase();
  const words = (PRESENT.words || []).map((w) => String(w).trim().toLowerCase()).filter((w) => w.length >= MIN_WORD);
  for (let k = Math.min(low.length, MASK_MAX - 1); k > 0; k--) {
    const tail = low.slice(-k);
    if (words.some((w) => w.length > k && w.startsWith(tail))) return k;
  }
  return 0;
}
// what is already on a terminal was drawn before: draw it again from the daemon's history, through the mask
function redrawTerms() {
  for (const [key, t] of terms) {
    const s = sessions.get(key);
    if (!s) continue;
    if (t.ws) { t.ws.onclose = null; t.ws.close(); }
    clearTimeout(t.mtimer);
    t.mpend = "";
    t.term.reset();
    t.ended = t.warned = false;
    for (const e of t.el.querySelectorAll(".ended")) e.remove();
    connect(s, t);
  }
}

// ---- the rest of the window: every text and every tooltip, as it is drawn (the terminals and this
// mode's own panel aside: those take care of themselves)
const skipNode = (n) => { const el = n.nodeType === 1 ? n : n.parentElement; return !el || !!el.closest(".xterm, #present, script, style"); };
function maskTree(root) {
  if (!PRESENT.on || !root) return;
  if (root.nodeType === 3) { if (!skipNode(root)) { const v = maskText(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; } return; }
  if (root.nodeType !== 1 || skipNode(root)) return;
  // REJECT leaves out a terminal or the panel with all that is inside them
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(".xterm, #present, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = root; n; n = walk.nextNode()) {
    if (n.nodeType === 3) { const v = maskText(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
    else if (n.title) { const v = maskText(n.title); if (v !== n.title) n.title = v; }
  }
}
const observer = new MutationObserver((list) => {
  for (const m of list) {
    if (m.type === "childList") for (const n of m.addedNodes) maskTree(n);
    else if (m.type === "characterData") maskTree(m.target);
    else if (m.type === "attributes" && m.target.title && !skipNode(m.target)) { const v = maskText(m.target.title); if (v !== m.target.title) m.target.title = v; }
  }
});

// ---- on and off: the whole window drawn again, so nothing from before stays
async function setPresent(on, redraw = true) {
  // turned on before the panel was ever opened (Ctrl+Shift+P): what is yours, found now
  if (on && PRESENT.words === null) { PRESENT.words = await defaultWords(); store.set("presentWords", PRESENT.words); buildMask(); }
  PRESENT.on = on;
  store.set("present", on);
  document.documentElement.classList.toggle("present-on", on);
  observer.disconnect();
  if (on) {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title"] });
    maskTree(document.documentElement);
  }
  paintPresentBtn();
  if (!redraw) return;
  renderSide();
  if (typeof VIEW !== "undefined" && VIEW) loadView(true);
  redrawTerms();
}
function paintPresentBtn() {
  const b = $("#presentbtn");
  b.textContent = PRESENT.on ? "● presentando" : "◉ presentación";
  b.classList.toggle("on", PRESENT.on);
  b.title = PRESENT.on ? "Modo presentación activo: tu usuario, tu mail y tus equipos se ven tapados. Clic para cambiarlo (Ctrl+Shift+P alterna)." : "Modo presentación: tapa tu usuario, tu mail, tus equipos y las palabras que elijas, para grabar o compartir pantalla (Ctrl+Shift+P)";
}

// what is yours, the first time: this machine's user, email and name, and the machines you connected
async function defaultWords() {
  const out = [];
  try {
    const w = await api("GET", "/api/who");
    out.push(w.user, w.email, w.machine);
  } catch { out.push(machines[0].name); }
  for (const mm of machines.slice(1)) {
    out.push(mm.name);
    const host = String(mm.target || "").replace(/^.*@/, "").replace(/:\d+$/, "");
    const user = String(mm.target || "").includes("@") ? mm.target.replace(/@.*$/, "") : "";
    if (host) out.push(host);
    if (user && user !== "root") out.push(user);
  }
  return [...new Set(out.filter((x) => x && String(x).trim().length >= MIN_WORD))];
}

// ---- the panel, over the bottom of the sidebar like the theme menu
async function openPresent(focusMid) {
  const p = $("#present");
  if (PRESENT.words === null) { PRESENT.words = await defaultWords(); store.set("presentWords", PRESENT.words); buildMask(); }
  p.innerHTML = `
    <div class="pt">modo presentación</div>
    <p class="pd">Para grabar o compartir pantalla: tapa con puntos tu usuario, tu mail, tus equipos y las palabras
      que agregues, en las terminales, el visor y toda la ventana. En la terminal el tapado tiene el mismo largo, así
      nada se desarma; los programas y los agentes siguen viendo todo igual.</p>
    <button id="ptoggle" class="primary"></button>
    <div class="pt">palabras a tapar <span class="muted">· una por línea</span></div>
    <textarea id="pwords" spellcheck="false" rows="5"></textarea>
    <p class="pd muted">Esta lista se ve: si ya estás grabando, se desenfoca hasta que hagas clic en ella.</p>
    <div class="pt">nombres de los dispositivos</div>
    <div id="paliases"></div>
    <p class="pd warn">Tapa lo que conoce. Si un agente muestra un secreto que no está en la lista (un .env, un token), se ve:
      para tutoriales, mejor una carpeta de demo sin secretos reales. Los archivos .env y las claves piden confirmación antes de abrirse.</p>`;
  $("#pwords").value = (PRESENT.words || []).join("\n");
  $("#pwords").onchange = () => {
    PRESENT.words = $("#pwords").value.split("\n").map((w) => w.trim()).filter(Boolean);
    store.set("presentWords", PRESENT.words);
    buildMask();
    if (PRESENT.on) setPresent(true);
  };
  const al = $("#paliases");
  for (const mm of machines) {
    const row = document.createElement("label");
    row.className = "pa";
    row.innerHTML = `<span class="pn"></span><input maxlength="40" spellcheck="false">`;
    row.querySelector(".pn").textContent = mm.mid === LOCAL ? "esta PC" : (mm.target || mm.mid);
    const inp = row.querySelector("input");
    inp.placeholder = mm.name || "";
    inp.value = ALIASES[mm.mid] || "";
    inp.onchange = () => {
      const v = inp.value.trim();
      if (v) ALIASES[mm.mid] = v; else delete ALIASES[mm.mid];
      store.set("aliases", ALIASES);
      renderSide();
    };
    al.append(row);
    if (mm.mid === focusMid) setTimeout(() => inp.focus(), 0);
  }
  const tg = $("#ptoggle");
  tg.textContent = PRESENT.on ? "Desactivar" : "Activar";
  tg.onclick = async () => { await setPresent(!PRESENT.on); tg.textContent = PRESENT.on ? "Desactivar" : "Activar"; };
  p.hidden = false;
}
$("#presentbtn").onclick = (e) => { e.stopPropagation(); if ($("#present").hidden) openPresent(); else $("#present").hidden = true; };
document.addEventListener("click", (e) => { if (!e.target.closest("#present, #presentbtn, #ctx")) $("#present").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#present").hidden = true; });

// a file that usually holds secrets: asked before it is shown while presenting
const SECRET_FILE = /(^|\/)(\.env(\..+)?|.+\.(pem|key|p12|pfx|jks|keystore|kdbx)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\..+)?|secrets?\.(json|ya?ml|toml|txt)|\.npmrc|\.pypirc|\.netrc|\.pgpass|daemon\.json|remote\.json)$/i;
async function presentGuard(path) {
  if (!PRESENT.on || !SECRET_FILE.test(path)) return true;
  return !!(await ask(`${baseName(path)} suele tener secretos (claves, tokens). Estás en modo presentación: ¿mostrarlo igual?`,
    [{ label: "No mostrar", value: false }, { label: "Mostrarlo", value: true, kind: "danger" }]));
}

// the QR that pairs a phone, blurred while presenting: anyone who sees it could pair theirs
$("#qrbox").addEventListener("click", () => { if (PRESENT.on) $("#qrbox").classList.add("reveal"); });
// and the relay's address, which leads to your server: blurred too, shown with a click
$("#relaynow").addEventListener("click", (e) => { if (PRESENT.on && e.target.id === "relayhost") e.target.classList.add("reveal"); });

buildMask();
paintPresentBtn();
if (PRESENT.on) setPresent(true, false);   // as you left it: from the first thing drawn
