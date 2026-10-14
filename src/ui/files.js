// files.js — the panel on the right: the files of the space on screen, with what git says changed
// (modified, new, deleted), a file read with its colors, and what changed in it (the diff since the
// last commit). Read only. It asks the daemon of the space's machine every few seconds while it is
// open, so what an agent writes shows up by itself. Uses app.js: $, api, base, spaceOf, current, store.
"use strict";

const FILES = {
  open: store.get("files", !document.documentElement.classList.contains("atril-phone") && innerWidth > 720),   // on a phone it would cover the terminal
  width: store.get("filesW", 320),
  pinned: store.get("filesPin", false),   // beside the terminal (it gets narrower) or floating over it
  sid: null,            // the space shown: "mid|key"
  dirs: {},             // folder ("." is the space) -> its entries, as the daemon listed them
  changes: {},          // path -> M | A | D | R | ??
  repo: false, branch: null,
  error: "",
  last: "",             // the last answer, to draw only when something changed
  busy: false,
  showChanges: store.get("filesChanges", true),
};
const openDirs = new Set();                        // folders open in the tree of FILES.sid
let VIEW = null;                                   // the file on screen: {sid, path, mode: file | diff, stamp}

const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "." : p.slice(0, i); };
const fmtSize = (n) => { n = Number(n) || 0; return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; };
const CODE_TEXT = { M: "modificado", A: "nuevo (en el índice)", D: "borrado", R: "renombrado", "??": "nuevo" };
const codeClass = (c) => (c === "??" || c === "A" ? "gN" : c === "D" ? "gD" : c ? "gM" : "");
const codeLetter = (c) => (c === "??" ? "N" : c === "A" ? "N" : c || "");

// ---- the panel: open, close, width; the terminal on screen fits what is left
function refit() { requestAnimationFrame(() => { const t = terms.get(lastTab[current]); if (t) t.fit.fit(); }); }
// floating, the panel covers the right of the terminal without resizing it: a TUI that lays itself out
// by width (OpenCode hides its sidebar when narrow) stays as it was. Docked, the terminal makes room.
// The viewer, which lives over the terminals, keeps clear of a floating panel
function filesLayout() {
  const f = $("#files");
  f.style.width = FILES.width + "px";
  f.hidden = !FILES.open;
  f.classList.toggle("float", !FILES.pinned);
  $("#filesbtn").classList.toggle("on", FILES.open);
  $("#fpin").textContent = FILES.pinned ? "flotar" : "fijar";
  $("#fpin").title = FILES.pinned ? "Que el panel flote sobre la terminal: la terminal conserva su ancho" : "Fijar el panel al costado: la terminal se angosta para dejarle lugar";
  $("#viewer").style.right = FILES.open && !FILES.pinned && innerWidth > 720 ? FILES.width + "px" : "0";
  refit();
}
function setFiles(open) {
  FILES.open = open;
  store.set("files", open);
  filesLayout();
  if (open) filesSync(true);
  else minimizeViewer();   // the file you were reading waits above the terminal, it is not lost
}
filesLayout();                                     // as you left it; the tree comes with the first space
$("#fpin").onclick = () => { FILES.pinned = !FILES.pinned; store.set("filesPin", FILES.pinned); filesLayout(); };
$("#filesbtn").onclick = () => setFiles(!FILES.open);
$("#fclose").onclick = () => setFiles(false);
$("#freload").onclick = () => { const b = $("#freload"); b.classList.remove("spin"); void b.offsetWidth; b.classList.add("spin"); filesRefresh(true); };
{
  // the edge on the left: drag it to make the panel wider or narrower
  const grip = $("#fgrip");
  grip.onpointerdown = (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = $("#files").offsetWidth;
    grip.onpointermove = (ev) => {
      FILES.width = Math.max(220, Math.min(innerWidth * 0.6, w0 + x0 - ev.clientX));
      filesLayout();
    };
    grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; store.set("filesW", Math.round(FILES.width)); };
  };
}

// called by app.js whenever the sidebar is drawn: a new space on screen starts its own tree
function filesSync(force) {
  if (VIEW && VIEW.sid !== current) minimizeViewer(false);   // it waits in its own space
  paintMini();
  if (!FILES.open) return;
  if (current !== FILES.sid) {
    FILES.sid = current;
    FILES.dirs = {}; FILES.changes = {}; FILES.repo = false; FILES.branch = null; FILES.error = ""; FILES.last = "";
    openDirs.clear();
    for (const d of store.get("filesOpen:" + current, [])) openDirs.add(d);
    paintFiles();
    filesRefresh(true);
  } else if (force) filesRefresh(true);
}
function saveOpenDirs() { store.set("filesOpen:" + FILES.sid, [...openDirs]); }

// ---- one trip: the open folders, git status, how the file on screen is now
async function filesRefresh(now) {
  const sp = spaceOf(FILES.sid);
  if (!FILES.open || !sp || (FILES.busy && !now)) return;
  const mm = machineOf(sp.mid);
  if (mm && mm.status !== "up") { FILES.error = "Esa máquina no está conectada ahora."; paintFiles(); return; }
  FILES.busy = true;
  const sid = FILES.sid;
  try {
    const r = await api("POST", base(sp.mid) + "/files/tree", { space: sp.key, dirs: [".", ...openDirs], watch: VIEW && VIEW.sid === sid ? VIEW.path : "" });
    if (sid !== FILES.sid) return;
    FILES.error = "";
    for (const [d, list] of Object.entries(r.dirs || {})) {
      if (list) FILES.dirs[d] = list;
      else { delete FILES.dirs[d]; if (d !== ".") openDirs.delete(d); }   // a folder that is gone
    }
    FILES.repo = r.repo; FILES.branch = r.branch; FILES.changes = r.changes || {};
    const now2 = JSON.stringify([r.dirs, r.changes, r.branch]);
    if (now2 !== FILES.last) { FILES.last = now2; paintFiles(); }
    // the file on screen changed on disk (an agent wrote it), or git says something else of it: read it again
    if (VIEW && VIEW.sid === sid && r.watch) {
      const stamp = JSON.stringify([r.watch.exists, r.watch.modified, r.watch.size, FILES.changes[VIEW.path] || ""]);
      if (VIEW.stamp && VIEW.stamp !== stamp) loadView(true);
      VIEW.stamp = stamp;
    }
  } catch (e) {
    if (sid !== FILES.sid) return;
    const old = sp.mid !== LOCAL && mm && mm.version !== myVersion;
    FILES.error = old ? `${machineName(mm)} tiene un Atril más viejo (${mm.version || "?"}), que no muestra archivos. Actualizalo: clic derecho en el dispositivo → Actualizar Atril ahí.` : e.message;
    FILES.last = "";
    paintFiles();
  } finally { FILES.busy = false; }
}
// while the panel is open and the window in view, every few seconds
setInterval(() => { if (FILES.open && !document.hidden) filesRefresh(false); }, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && FILES.open) filesRefresh(false); });

// ---- drawing: the git line, the changes, the tree
function paintFiles() {
  const sp = spaceOf(FILES.sid);
  const ch = FILES.changes;
  const paths = Object.keys(ch).sort((a, b) => a.localeCompare(b));
  const k = { M: 0, N: 0, D: 0 };
  for (const p of paths) { const c = ch[p]; if (c === "??" || c === "A") k.N++; else if (c === "D") k.D++; else k.M++; }
  // the git line: the branch and only the counts that are not zero
  const g = $("#fgit");
  if (!sp) g.innerHTML = "";
  else if (!FILES.repo) g.innerHTML = `<span class="muted">${FILES.dirs["."] ? "sin git" : ""}</span>`;
  else {
    const parts = [];
    if (k.M) parts.push(`<b class="gM">~${k.M}</b>`);
    if (k.N) parts.push(`<b class="gN">+${k.N}</b>`);
    if (k.D) parts.push(`<b class="gD">−${k.D}</b>`);
    g.innerHTML = `<span class="br">⎇ ${escH(FILES.branch || "?")}</span>` + (parts.length ? parts.join("") : '<b class="ok">✓</b>');
    g.title = parts.length ? `${k.M} modificados · ${k.N} nuevos · ${k.D} borrados` : "nada cambió desde el último commit";
  }

  // the changes: every file git sees changed, flat; a click shows what changed
  const cl = $("#fchanges");
  cl.innerHTML = "";
  if (sp && paths.length) {
    const h = document.createElement("div");
    h.className = "fsec";
    h.innerHTML = `<span class="tw">${FILES.showChanges ? "▾" : "▸"}</span>cambios <span class="muted">${paths.length}</span>`;
    h.onclick = () => { FILES.showChanges = !FILES.showChanges; store.set("filesChanges", FILES.showChanges); paintFiles(); };
    cl.append(h);
    if (FILES.showChanges) {
      const box = document.createElement("div");
      box.className = "flist";
      for (const p of paths.slice(0, 500)) {
        const r = document.createElement("div");
        r.className = "fr file " + codeClass(ch[p]) + (VIEW && VIEW.path === p ? " on" : "");
        r.title = `${p} · ${CODE_TEXT[ch[p]] || ch[p]}`;
        r.innerHTML = `<span class="nm"></span><span class="dn"></span><span class="gs"></span>`;
        r.querySelector(".nm").textContent = baseName(p);
        r.querySelector(".dn").textContent = dirName(p) === "." ? "" : dirName(p);
        r.querySelector(".gs").textContent = codeLetter(ch[p]);
        r.onclick = () => openFile(p, "diff");
        box.append(r);
      }
      if (paths.length > 500) { const m = document.createElement("div"); m.className = "fr none"; m.textContent = `… y ${paths.length - 500} más`; box.append(m); }
      cl.append(box);
    }
  }

  // the tree: folders with a change inside are tinted; a deleted file stays, struck through, until committed
  const tree = $("#ftree");
  const top = tree.scrollTop;
  tree.innerHTML = "";
  if (!sp) { tree.innerHTML = `<div class="fnote">Elegí un space para ver sus archivos.</div>`; return; }
  const h = document.createElement("div");
  h.className = "fsec";
  h.textContent = sp.name;
  h.title = sp.path;
  tree.append(h);
  if (FILES.error) { const e = document.createElement("div"); e.className = "fnote err"; e.textContent = FILES.error; tree.append(e); }
  if (!FILES.dirs["."]) { if (!FILES.error) { const e = document.createElement("div"); e.className = "fnote"; e.textContent = "leyendo…"; tree.append(e); } return; }
  const changedDirs = new Set();
  for (const p of paths) { let d = dirName(p); while (d !== ".") { changedDirs.add(d); d = dirName(d); } }
  const draw = (dir, depth) => {
    const list = (FILES.dirs[dir] || []).slice();
    const names = new Set(list.map((e) => e.name));
    for (const p of paths) if (ch[p] === "D" && dirName(p) === dir && !names.has(baseName(p))) list.push({ name: baseName(p), dir: false, gone: true });
    for (const e of list) {
      const path = dir === "." ? e.name : dir + "/" + e.name;
      const r = document.createElement("div");
      const c = e.dir ? (changedDirs.has(path) ? "gM" : "") : codeClass(ch[path]);
      r.className = "fr " + (e.dir ? "dir " : "file ") + c + (e.gone ? " gone" : "") + (VIEW && VIEW.path === path ? " on" : "");
      r.style.paddingLeft = 8 + depth * 14 + "px";
      r.dataset.path = path;
      r.innerHTML = `<span class="tw"></span><span class="nm"></span><span class="gs"></span>`;
      r.querySelector(".tw").textContent = e.dir ? (openDirs.has(path) ? "▾" : "▸") : "";
      r.querySelector(".nm").textContent = e.name + (e.dir ? "/" : "");
      r.querySelector(".gs").textContent = e.dir ? "" : codeLetter(ch[path]);
      r.title = path + (ch[path] ? " · " + (CODE_TEXT[ch[path]] || ch[path]) : "") + (e.size != null && !e.dir ? " · " + fmtSize(e.size) : "");
      if (e.dir) r.onclick = () => toggleDir(path);
      else r.onclick = () => openFile(path, e.gone ? "diff" : "file");
      tree.append(r);
      if (e.dir && openDirs.has(path)) {
        if (FILES.dirs[path]) draw(path, depth + 1);
        else { const l = document.createElement("div"); l.className = "fr none"; l.style.paddingLeft = 22 + (depth + 1) * 14 + "px"; l.textContent = "…"; tree.append(l); }
      }
    }
    if (!list.length && dir === ".") { const n = document.createElement("div"); n.className = "fnote"; n.textContent = "carpeta vacía"; tree.append(n); }
  };
  draw(".", 0);
  tree.scrollTop = top;
}

function toggleDir(path) {
  if (openDirs.has(path)) { for (const d of [...openDirs]) if (d === path || d.startsWith(path + "/")) openDirs.delete(d); }
  else openDirs.add(path);
  saveOpenDirs();
  paintFiles();
  if (openDirs.has(path) && !FILES.dirs[path]) filesRefresh(true);
}

// ---- the viewer: over the terminals, in the middle. One file open at a time; the ones you minimized
// wait above the terminal (MINI), each with its place, until you open or drop them. Opening another
// file or closing this one leaves them where they are
const MINI = [];               // {sid, path, mode, line, scroll: {top, left}}, the newest last
const MINI_MAX = 6;
const sameFile = (a, b) => a.sid === b.sid && a.path === b.path;

// (from a terminal: the space of that terminal, and the line it named, if any)
// a Markdown file opens to be read, drawn; at a line a terminal named, as the text it is
async function openFile(path, mode, line = 0, sid = FILES.sid) {
  if (typeof presentGuard === "function" && !(await presentGuard(path))) return;   // present.js: a .env while presenting
  if (mode === "file" && !line && isMd(path)) mode = "read";
  if (mode === "file" && !line && docKind(path)) mode = "doc";
  VIEW = { sid, path, mode, line, stamp: null };
  const i = MINI.findIndex((m) => sameFile(m, VIEW));
  if (i >= 0) MINI.splice(i, 1);   // it is open now, not waiting
  paintMini();
  $("#viewer").hidden = false;
  $("#vbody").scrollTop = 0;
  // the keys leave the terminal: Esc minimizes the viewer instead of reaching the program
  $("#vbody").focus({ preventScroll: true });
  paintFiles();
  await loadView(false);
}
function backToTerminal() {
  const t = terms.get(lastTab[current]);
  if (t) requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
}
function hideViewer() {
  VIEW = null;
  $("#viewer").hidden = true;
  $("#vbody").innerHTML = "";
  dropBlob();
  if (FILES.open) paintFiles();
}
function closeViewer() {
  if (!VIEW && $("#viewer").hidden) return;
  hideViewer();
  backToTerminal();
}
// the file on screen joins the ones waiting, with the place you were reading
function minimizeViewer(focus = true) {
  if (!VIEW) return;
  const body = $("#vbody");
  const m = { sid: VIEW.sid, path: VIEW.path, mode: VIEW.mode, line: VIEW.line, scroll: { top: body.scrollTop, left: body.scrollLeft } };
  const i = MINI.findIndex((x) => sameFile(x, m));
  if (i >= 0) MINI.splice(i, 1);
  MINI.push(m);
  if (MINI.length > MINI_MAX) MINI.shift();
  hideViewer();
  paintMini();
  if (focus) backToTerminal();
}
// a waiting file back on screen, read again (it may have changed) and at the same place; the one on
// screen, if any, takes its turn waiting
function restoreMini(m) {
  if (VIEW) minimizeViewer(false);
  MINI.splice(MINI.indexOf(m), 1);
  VIEW = { sid: m.sid, path: m.path, mode: m.mode, line: m.line, stamp: null };
  paintMini();
  $("#viewer").hidden = false;
  $("#vbody").focus({ preventScroll: true });
  paintFiles();
  loadView(false, m.scroll);
}
// the waiting files of the space on screen, above its terminals
function paintMini() {
  const box = $("#vchips");
  box.innerHTML = "";
  for (const m of MINI) {
    if (m.sid !== current) continue;
    const c = document.createElement("span");
    c.className = "vchip";
    c.innerHTML = `<button class="n"></button><button class="x" title="Olvidarlo">×</button>`;
    c.querySelector(".n").textContent = "▤ " + baseName(m.path);
    c.querySelector(".n").title = `Volver a ${m.path} donde lo dejaste`;
    c.querySelector(".n").onclick = () => restoreMini(m);
    c.querySelector(".x").onclick = () => { MINI.splice(MINI.indexOf(m), 1); paintMini(); };
    box.append(c);
  }
}
$("#vclose").onclick = closeViewer;
$("#vmin").onclick = () => minimizeViewer();
$("#vmode").onclick = (e) => { const m = e.target.dataset.m; if (!m || !VIEW || VIEW.mode === m) return; VIEW.mode = m; loadView(false); };
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("#viewer").hidden) return;
  if (!$("#palette").hidden || !$("#picker").hidden || !$("#conn").hidden || !$("#dialog").hidden) return;
  minimizeViewer();
});

// keepScroll: the same file read again, where it was; at: a place to go back to once it is drawn
async function loadView(keepScroll, at = null) {
  const v = VIEW;
  const sp = v && spaceOf(v.sid);
  if (!sp) return;
  const code = v.sid === FILES.sid ? FILES.changes[v.path] : undefined;
  // read (Markdown only), seen as it looks (a PDF, an image, an Office file), the file as text (not
  // for those that are not text), what changed (only when git says something did)
  const kind = docKind(v.path);
  const can = kind && kind !== "svg" ? ["doc"]
    : [...(isMd(v.path) ? ["read"] : []), ...(kind ? ["doc"] : []), "file", ...(code ? ["diff"] : [])];
  const mode = can.includes(v.mode) ? v.mode : can[0];
  const body = $("#vbody");
  const top = at ? at.top : body.scrollTop, left = at ? at.left : body.scrollLeft;
  $("#vpath").textContent = v.path + (v.line ? ":" + v.line : "");
  $("#vpath").title = sp.path + "/" + v.path;
  const modes = $("#vmode");
  modes.hidden = can.length < 2;
  for (const b of modes.querySelectorAll("button")) { b.hidden = !can.includes(b.dataset.m); b.classList.toggle("on", b.dataset.m === mode); }
  const q = `?space=${encodeURIComponent(sp.key)}&path=${encodeURIComponent(v.path)}`;
  if (!keepScroll) {
    dropBlob();
    body.innerHTML = `<div class="fnote">${mode === "doc" && kind === "office" ? "convirtiendo a PDF con LibreOffice… (la primera vez tarda unos segundos)" : "leyendo…"}</div>`;
    $("#vmeta").textContent = "";
  }
  try {
    let html, meta, blob = null;
    if (mode === "doc") {
      const r = await api("GET", base(sp.mid) + "/files/raw" + q + (kind === "office" ? "&as=pdf" : ""));
      if (VIEW !== v) return;
      if (!r.gone) v.stamp = JSON.stringify([true, r.modified, r.size, code || ""]);
      [html, meta, blob] = docView(r, v.path, kind);
    } else if (mode === "diff" && code !== "??" && code !== "A") {
      const d = await api("GET", base(sp.mid) + "/files/diff" + q);
      if (VIEW !== v) return;
      [html, meta] = diffView(d.diff, v.path);
    } else {
      const f = await api("GET", base(sp.mid) + "/files/read" + q);
      if (VIEW !== v) return;
      // how the file was when read, as filesRefresh compares it: a change right after opening it shows too
      if (f.content != null) v.stamp = JSON.stringify([true, f.modified, f.size, code || ""]);
      if (f.gone) { html = `<div class="fnote">Este archivo ya no existe${code === "D" ? ": está borrado. «diff» muestra lo que tenía." : "."}</div>`; meta = ""; }
      else if (f.binary) { html = `<div class="fnote">No es texto (una imagen, una base de datos, un ejecutable…): no se puede mostrar acá.</div>`; meta = "binario · " + fmtSize(f.size); }
      else if (f.error) { html = `<div class="fnote err">${escH(f.error)}</div>`; meta = ""; }
      else if (mode === "diff") [html, meta] = newFileView(f.content, v.path, f.truncated);   // new: all of it is the change
      else if (mode === "read") [html, meta] = mdView(f.content, f.truncated, f.size);
      else [html, meta] = sourceView(f.content, v.path, f.truncated, f.size);
    }
    dropBlob();
    body.innerHTML = html;
    BLOB = blob;
    $("#vmeta").innerHTML = meta;
    if (v.line) markLine(v.line, !keepScroll && !at);
    if (keepScroll || at) { body.scrollTop = top; body.scrollLeft = left; }
  } catch (e) {
    if (VIEW !== v) return;
    body.innerHTML = `<div class="fnote err">${escH(e.message)}</div>`;
  }
}

// the line a terminal named: tinted, and a third of the way down the viewer the first time
function markLine(n, scroll) {
  const src = $("#vbody .src"), pre = src && src.querySelector(".txt");
  if (!pre) return;
  const cs = getComputedStyle(pre);
  const lh = parseFloat(cs.lineHeight) || 20, y = (parseFloat(cs.paddingTop) || 0) + (n - 1) * lh;
  const m = document.createElement("div");
  m.className = "vline";
  m.style.top = y + "px";
  m.style.height = lh + "px";
  src.append(m);
  if (scroll) { const body = $("#vbody"); body.scrollTop = Math.max(0, y - body.clientHeight / 3); }
}

// a file with its colors and its line numbers
function sourceView(src, path, truncated, size) {
  const lang = langOf(path);
  let html = escH(src);
  if (lang !== "plaintext" && src.length <= 120000 && typeof hljs !== "undefined") {
    try { html = hljs.highlight(src, { language: lang, ignoreIllegals: true }).value; } catch {}
  }
  const n = src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
  let gut = "";
  for (let i = 1; i <= Math.max(n, 1); i++) gut += i + "\n";
  const meta = [lang === "plaintext" ? "texto" : lang, n + (n === 1 ? " línea" : " líneas"), fmtSize(size)];
  if (truncated) meta.push('<span class="warn">muy grande: se muestra el principio</span>');
  return [`<div class="src"><pre class="gut">${gut}</pre><pre class="txt"><code class="hljs">${html}</code></pre></div>`, meta.join(" · ")];
}

// a new file in diff mode: every line is added
function newFileView(src, path, truncated) {
  const lines = src.replace(/\r/g, "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const rows = lines.map((l, i) => `<div class="dl plus"><span class="o"></span><span class="n">${i + 1}</span><span class="c">+${escH(l)}</span></div>`);
  return [`<div class="diff">${rows.join("")}</div>`, `<b class="gN">nuevo</b> · +${lines.length}` + (truncated ? ' · <span class="warn">se muestra el principio</span>' : "")];
}

// ---- a file seen as it looks: a PDF in the browser's own viewer, an image, an Office file as the PDF
// LibreOffice makes of it (on the machine of the space). The bytes become a blob whose type comes from
// the file's name: a file named .pdf is shown as a PDF whatever it holds, never as a page of this window
const DOC_EXT = {
  pdf: "pdf", png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img", bmp: "img", ico: "img", avif: "img", svg: "svg",
  pptx: "office", ppt: "office", odp: "office", key: "office", docx: "office", doc: "office", odt: "office", rtf: "office",
  xlsx: "office", xls: "office", ods: "office",
};
const IMG_TYPE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml" };
const extOf = (path) => { const b = baseName(path).toLowerCase(), i = b.lastIndexOf("."); return i > 0 ? b.slice(i + 1) : ""; };
const docKind = (path) => DOC_EXT[extOf(path)] || "";
let BLOB = null;               // the blob URL on screen, let go when the viewer shows something else
function dropBlob() { if (BLOB) { URL.revokeObjectURL(BLOB); BLOB = null; } }
function fromBase64(s) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function docView(r, path, kind) {
  const ext = extOf(path);
  if (r.gone) return [`<div class="fnote">Este archivo ya no existe.</div>`, "", null];
  if (r.error) return [`<div class="fnote err">${escH(r.error)}</div>`, "", null];
  if (r.too_big) return [`<div class="fnote">Es muy grande para mostrarlo acá (${fmtSize(r.size)}; hasta ${fmtSize(25000000)}).</div>`, fmtSize(r.size), null];
  if (r.no_office) return [`<div class="fnote">Para ver un .${escH(ext)} acá, esa máquina necesita <b>LibreOffice</b>: Atril lo usa (sin abrir ventanas) para convertirlo a PDF. Instalalo y volvé a abrir el archivo.</div>`, fmtSize(r.size), null];
  const img = kind === "img" || kind === "svg";
  const name = kind === "office" ? baseName(path).replace(/\.[^.]*$/, "") + ".pdf" : baseName(path);   // what «descargar» saves it as
  const url = URL.createObjectURL(new File([fromBase64(r.data)], name, { type: img ? IMG_TYPE[ext] : "application/pdf" }));
  const html = img ? `<div class="docimg"><img src="${url}" alt=""${kind === "svg" ? ' class="svg"' : ""}></div>` : `<iframe class="docpdf" src="${url}" title="${escH(baseName(path))}"></iframe>`;
  const meta = kind === "office" ? `${ext} → PDF (LibreOffice) · ${fmtSize(r.size)}` : `${img ? "imagen" : "PDF"} · ${fmtSize(r.size)}`;
  return [html, meta, url];
}

// ---- Markdown, drawn to be read. What a file says never runs here: DOMPurify takes out scripts,
// handlers, forms and styles (this window holds the key to your terminals); ids are taken out too
// (an id="vbody" in a README would take the viewer's place) and headings get their own, "md-…"
const isMd = (path) => /\.(md|markdown|mdx)$/i.test(path);
const slug = (s) => "md-" + s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
function mdView(src, truncated, size) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") return sourceView(src, "x.md", truncated, size);
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(marked.parse(src, { gfm: true }), {
    FORBID_TAGS: ["style", "form", "button", "textarea", "select"], FORBID_ATTR: ["style", "id", "name"],
  });
  const d = tpl.content;
  const used = new Set();
  for (const h of d.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    let id = slug(h.textContent), n = 1;
    while (used.has(id)) id = slug(h.textContent) + "-" + n++;
    used.add(id);
    h.id = id;
  }
  // an image here can only come from the web: one beside the file is not served, so its text stands in
  for (const img of d.querySelectorAll("img")) {
    if (/^(https?:|data:image\/)/i.test(img.getAttribute("src") || "")) { img.loading = "lazy"; continue; }
    const s = document.createElement("span");
    s.className = "muted";
    s.textContent = `[imagen: ${img.getAttribute("alt") || img.getAttribute("src") || ""}]`;
    img.replaceWith(s);
  }
  for (const c of d.querySelectorAll("pre code")) {
    const lang = ((c.className.match(/language-([\w+#-]+)/) || [])[1] || "").toLowerCase();
    const known = typeof hljs !== "undefined" && lang && hljs.getLanguage(LANG_BY_EXT[lang] || lang);
    if (known) { try { c.innerHTML = hljs.highlight(c.textContent, { language: LANG_BY_EXT[lang] || lang, ignoreIllegals: true }).value; } catch {} }
    c.classList.add("hljs");
  }
  for (const box of d.querySelectorAll("input")) box.disabled = true;   // a task list: [x]
  const n = src.split("\n").length;
  const meta = ["markdown", n + (n === 1 ? " línea" : " líneas"), fmtSize(size)];
  if (truncated) meta.push('<span class="warn">muy grande: se muestra el principio</span>');
  return [`<article class="md">${tpl.innerHTML}</article>`, meta.join(" · ")];
}
// a link in a Markdown file: to the web, in the browser; to a heading, there; to another file of the
// space, in this same viewer (the window itself never goes anywhere)
$("#vbody").addEventListener("click", (e) => {
  const a = e.target.closest(".md a[href]");
  if (!a || !VIEW) return;
  e.preventDefault();
  const href = a.getAttribute("href");
  if (/^(https?:|mailto:)/i.test(href)) { window.open(href, "_blank", "noopener"); return; }
  if (href.startsWith("#")) {
    const h = $("#vbody").querySelector("#" + CSS.escape(slug(decodeURIComponent(href.slice(1)).replace(/-/g, " "))));
    if (h) h.scrollIntoView({ block: "start" });
    return;
  }
  if (/^[a-z][\w+.-]*:/i.test(href)) return;   // another scheme: nothing
  let p = href.split("#")[0].split("?")[0];
  try { p = decodeURIComponent(p); } catch {}
  const sp = spaceOf(VIEW.sid);
  const dir = dirName(VIEW.path);
  const rel = sp && p && relIn("/s", p.startsWith("/") ? "/s" : "/s/" + (dir === "." ? "" : dir), p.replace(/^\//, ""));
  if (!rel) return;
  existing(sp, [rel]).then((kindOf) => {
    if (kindOf(rel)) openLink(VIEW.sid, rel, kindOf(rel), 0);
    else notice(`${rel} no está en el space.`);
  }, (err) => notice(err.message));
});

// git diff, drawn: a hunk header, then each line with its number before and after
function diffView(text, path) {
  if (!text || !text.trim()) return [`<div class="fnote">Sin cambios desde el último commit.</div>`, ""];
  const out = [];
  let o = 0, n = 0, adds = 0, dels = 0, hunks = 0;
  for (const l of text.replace(/\r/g, "").split("\n")) {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { o = +h[1]; n = +h[2]; hunks++; out.push(`<div class="dl hunk"><span class="o">…</span><span class="n">…</span><span class="c">${escH(l)}</span></div>`); continue; }
    if (!hunks) continue;   // the header of the diff: the panel already says which file
    if (l.startsWith("+")) { adds++; out.push(`<div class="dl plus"><span class="o"></span><span class="n">${n++}</span><span class="c">${escH(l)}</span></div>`); }
    else if (l.startsWith("-")) { dels++; out.push(`<div class="dl minus"><span class="o">${o++}</span><span class="n"></span><span class="c">${escH(l)}</span></div>`); }
    else if (l.startsWith("\\")) out.push(`<div class="dl note"><span class="o"></span><span class="n"></span><span class="c">${escH(l)}</span></div>`);
    else if (l.startsWith(" ")) out.push(`<div class="dl"><span class="o">${o++}</span><span class="n">${n++}</span><span class="c">${escH(l)}</span></div>`);
  }
  if (!hunks) return [`<div class="fnote">${/Binary files/.test(text) ? "Es un archivo binario: cambió, pero no se puede mostrar la diferencia." : escH(text)}</div>`, ""];
  return [`<div class="diff">${out.join("")}</div>`, `<b class="gN">+${adds}</b> <b class="gD">−${dels}</b> · desde el último commit`];
}

// ---- paths in a terminal are links: what an agent says it wrote (src/app.js, src\app.js:12, an
// absolute path inside the space) opens in the viewer with a click, and a folder opens in the panel.
// Only what the daemon says exists in the space of that terminal is underlined; it is asked once per
// path every little while, not on every move of the mouse
const PATH_RE = /(?:[A-Za-z]:)?[\w.~\-\/\\@+%=#$&!À-ɏЀ-ӿ぀-鿿]+(?::\d+){0,2}/g;
const SEEN = new Map();        // "sid|rel" -> {kind: "file" | "dir" | "", at}
const SEEN_MS = 15000;
const slashes = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

// a path as a terminal printed it -> relative to the space's root (dir: where the program runs), or
// null when it is not inside the space
function relIn(root, dir, p) {
  root = slashes(root);
  p = slashes(p);
  const abs = /^[A-Za-z]:\//.test(p) || p.startsWith("/") ? p : dir ? slashes(dir) + "/" + p : null;
  if (!abs) return null;
  const parts = abs.split("/"), out = [parts[0]];
  for (const seg of parts.slice(1)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (out.length > 1) out.pop(); continue; }
    out.push(seg);
  }
  const full = out.join("/");
  const win = /^[A-Za-z]:/.test(root);   // Windows: the same path in any case
  const a = win ? full.toLowerCase() : full, b = win ? root.toLowerCase() : root;
  return a.startsWith(b + "/") && a.length > b.length + 1 ? full.slice(root.length + 1) : null;
}

// what looks like a path in a line: with a / or \ in it, or a name with an extension; ":12" or
// ":12:5" after it is the line. The period that ends a sentence is not part of it
function pathTokens(text) {
  const out = [];
  for (const m of text.matchAll(PATH_RE)) {
    const s = m[0].replace(/[.!?,=&#$%+@~\-]+$/, "");
    const [, path, line] = s.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
    if (path.length < 3 || /^[\d.]+$/.test(path) || path.startsWith("//")) continue;
    if (!/[\/\\]/.test(path) && !/\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path)) continue;
    out.push({ path, line: line ? +line : 0, start: m.index, end: m.index + s.length });
  }
  return out;
}

// the whole line under row y (0-based), a long line the terminal wrapped included, and the cell
// (1-based, as links want it) of each character
function wrappedLine(buf, y) {
  let top = y;
  while (top > 0 && y - top < 20 && buf.getLine(top) && buf.getLine(top).isWrapped) top--;
  let text = "";
  const cells = [];
  for (let r = top; r < top + 40; r++) {
    const line = buf.getLine(r);
    if (!line || (r > top && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      if (!c || c.getWidth() === 0) continue;   // the second half of a wide character
      const ch = c.getChars() || " ";
      for (let k = 0; k < ch.length; k++) cells.push({ x: x + 1, y: r + 1 });
      text += ch;
    }
  }
  return { text, cells };
}

// which of these paths exist in the space: what was asked a moment ago is remembered, the rest asked now
async function existing(sp, rels) {
  const now = Date.now();
  const ask = [...new Set(rels)].filter((r) => { const e = SEEN.get(sp.sid + "|" + r); return !e || now - e.at > SEEN_MS; }).slice(0, 50);
  if (ask.length) {
    const r = await api("POST", base(sp.mid) + "/files/exist", { space: sp.key, paths: ask });
    if (SEEN.size > 5000) SEEN.clear();
    for (const rel of ask) SEEN.set(sp.sid + "|" + rel, { kind: (r.found || {})[rel] || "", at: now });
  }
  return (rel) => (SEEN.get(sp.sid + "|" + rel) || {}).kind || "";
}

// the space of the session behind a terminal, and the folder its program runs in
function whereOf(key) {
  const s = sessions.get(key);
  const sp = s && spaceOf(spaceId(s.mid, s.space));
  return sp ? { sp, dir: s.here || s.cwd || sp.path } : null;
}

// called by app.js for each terminal it makes
function fileLinks(t, key) {
  t.term.registerLinkProvider({
    provideLinks(row, done) {
      const w = whereOf(key);
      if (!w) return done(undefined);
      const { text, cells } = wrappedLine(t.term.buffer.active, row - 1);
      const found = pathTokens(text)
        .map((k) => ({ ...k, rels: [relIn(w.sp.path, w.dir, k.path), relIn(w.sp.path, w.sp.path, k.path)].filter(Boolean) }))
        .filter((k) => k.rels.length && cells[k.start].y <= row && cells[k.end - 1].y >= row);
      if (!found.length) return done(undefined);
      existing(w.sp, found.flatMap((k) => k.rels)).then((kindOf) => {
        const links = [];
        for (const k of found) {
          const rel = k.rels.find((r) => kindOf(r));
          if (!rel) continue;
          links.push({
            range: { start: cells[k.start], end: cells[k.end - 1] },
            text: text.slice(k.start, k.end),
            decorations: { underline: true, pointer: true },
            activate: () => openLink(w.sp.sid, rel, kindOf(rel), k.line),
          });
        }
        done(links.length ? links : undefined);
      }, () => done(undefined));   // a daemon older than this window: no links
    },
  });
}

// a link a program printed itself (OSC 8): a file:// one opens in the same viewer, when the file is in the space
function termLinkHandler(key) {
  return {
    allowNonHttpProtocols: true,
    activate(e, uri) {
      if (!/^file:/i.test(uri)) { if (/^https?:/i.test(uri)) window.open(uri, "_blank", "noopener"); return; }
      const w = whereOf(key);
      let p = "";
      try { p = decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/, "$1"); } catch {}
      const rel = w && p && relIn(w.sp.path, null, p);
      if (!rel) { notice("Ese archivo está fuera del space: Atril abre solo los de adentro."); return; }
      existing(w.sp, [rel]).then((kindOf) => {
        if (kindOf(rel)) openLink(w.sp.sid, rel, kindOf(rel), 0);
        else notice("Ese archivo ya no existe.");
      }, (err) => notice(err.message));
    },
  };
}

async function openLink(sid, rel, kind, line) {
  if (sid !== current) return;
  if (kind === "file") return openFile(rel, "file", line, sid);
  // a folder: the panel open, with it unfolded and in view
  if (!FILES.open) setFiles(true);
  else filesSync();
  for (let d = rel; d !== "."; d = dirName(d)) openDirs.add(d);
  saveOpenDirs();
  paintFiles();
  await filesRefresh(true);
  const r = $("#ftree").querySelector(`.fr.dir[data-path="${CSS.escape(rel)}"]`);
  if (r) { r.scrollIntoView({ block: "nearest" }); r.classList.add("flash"); setTimeout(() => r.classList.remove("flash"), 1200); }
}

// ---- colors by kind of file (from lampson's editor: highlight.js "common" + Synsema and Prisma)
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', xsl: 'xml', plist: 'xml',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', py: 'python', rs: 'rust', go: 'go',
  sh: 'bash', bash: 'bash', zsh: 'bash', env: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', lua: 'lua', r: 'r', pl: 'perl',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
  wasm: 'wasm', wat: 'wasm', syn: 'synsema', fsyn: 'synsema', txt: 'plaintext', log: 'plaintext', csv: 'plaintext', lock: 'plaintext',
  prisma: 'prisma', tsbuildinfo: 'json', map: 'json', webmanifest: 'json', jsonl: 'json', har: 'json', mdx: 'markdown', proto: 'protobuf',
  bat: 'dos', cmd: 'dos', psql: 'sql', pgsql: 'sql', mysql: 'sql', m: 'objectivec', csproj: 'xml', xaml: 'xml', astro: 'xml', ejs: 'xml', hbs: 'xml',
  // names that are not extensions (a language said by name)
  javascript: 'javascript', typescript: 'typescript', python: 'python', rust: 'rust', shell: 'bash', powershell: 'powershell',
  synsema: 'synsema', html5: 'xml', dockerfile: 'dockerfile', makefile: 'makefile', text: 'plaintext', plaintext: 'plaintext'
};
const LANG_BY_NAME = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', '.env': 'bash', '.env.example': 'bash', '.gitignore': 'plaintext', '.gitattributes': 'plaintext', '.npmrc': 'ini', '.editorconfig': 'ini', '.nvmrc': 'plaintext', '.babelrc': 'json', '.eslintrc': 'json', '.prettierrc': 'json', '.swcrc': 'json', 'nginx.conf': 'nginx', procfile: 'plaintext' };
function langOf(path) {
  const base = String(path || '').split('/').pop().toLowerCase();
  if (LANG_BY_NAME[base]) return LANG_BY_NAME[base];
  if (base.startsWith('.env')) return 'bash';            // .env.local, .env.production…
  if (base.startsWith('dockerfile')) return 'dockerfile'; // Dockerfile.dev
  const i = base.lastIndexOf('.'); const ext = i >= 0 ? base.slice(i + 1) : '';
  return LANG_BY_EXT[ext] || 'plaintext';
}
// ---- Synsema para highlight.js (misma partición que el tmLanguage: control, tipos, seguridad, agentes, LLM,
// humano, observabilidad, serve, módulos; builtins solo cuando se llaman; task/type/agent + nombre = definición) ----
function synsemaGrammar(hljs) {
  const KEYWORDS = [
    'when', 'otherwise', 'each', 'while', 'repeat', 'match', 'is', 'try', 'recover', 'give', 'stop', 'then', 'and_then', 'return',
    'let', 'be', 'set', 'to', 'task', 'type', 'agent', 'state',
    'and', 'or', 'not', 'in', 'of', 'as', 'with',
    'spawn', 'share', 'observe', 'signal', 'wait_for',
    'analyze', 'decide', 'reason', 'generate',
    'approve', 'confirm', 'ask', 'show',
    'trace', 'log', 'measure', 'checkpoint',
    'serve', 'on', 'route', 'auth', 'errors', 'requires', 'expect', 'max_body', 'max_streams', 'stream', 'send', 'static', 'cache', 'fallback', 'cors', 'describe', 'private', 'from', 'domain', 'tls', 'redirect', 'proxy', 'host', 'paged', 'per', 'rate_limit', 'unlimited', 'none', 'mount', 'at',
    'use', 'export', 'routes', 'enum'
  ];
  const SECURITY = ['require', 'allow', 'deny', 'sandbox', 'intent', 'invariant', 'verify'];
  const BUILTINS = ['print', 'text', 'length', 'append', 'range', 'contains', 'split', 'join', 'type_of', 'matches', 'find_all', 'capture', 'replace_re', 'fetch', 'read_file', 'write_file', 'http', 'http_get', 'http_post', 'sql', 'sql_exec', 'sql_tables', 'db_open', 'db_close', 'format_time', 'parse_time', 'date_parts', 'now', 'sleep', 'apply', 'where', 'reduce', 'collect', 'transform', 'sort_by', 'group_by', 'every', 'some', 'flatten', 'parallel_map', 'chunk', 'remember', 'recall', 'forget_memory', 'add_rule', 'check_rules', 'get_rules', 'memory_summary', 'create_progress', 'start_step', 'complete_step', 'fail_step', 'resume_point', 'progress_display', 'progress_percent', 'ok', 'created', 'not_found', 'fail', 'html', 'respond', 'render', 'page', 'heading', 'prose', 'list', 'ordered_list', 'link', 'image', 'section', 'code', 'raw', 'content'];
  const NUMBER = { scope: 'number', match: /\b[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?\b/ };
  const CALL = { scope: 'built_in', match: new RegExp('\\b(' + BUILTINS.join('|') + ')(?=\\s*\\()') };
  // {expr} dentro de un string: termina en }, pero también ante la comilla que cierra el string o al final de la
  // línea, así una llave sin cerrar no arrastra el color
  const subst = (quote) => ({ scope: 'subst', begin: /\{/, end: new RegExp('\\}|(?=' + quote + ')|$'), keywords: { keyword: KEYWORDS, literal: ['true', 'false', 'nothing'] }, contains: [NUMBER, CALL] });
  return {
    name: 'Synsema', aliases: ['syn', 'fsyn'],
    keywords: { $pattern: /[A-Za-z_][A-Za-z0-9_]*/, keyword: KEYWORDS, literal: ['true', 'false', 'nothing'] },
    contains: [
      hljs.COMMENT('--', '$'),
      // los strings no cruzan líneas: end también en $ (hljs compila con la bandera m). Sin esto una comilla o un
      // backtick sin cerrar pintaban el resto del archivo como string (visto 2026-09-05 con un ` suelto en un .syn)
      { scope: 'string', begin: /"/, end: /"|$/, contains: [{ scope: 'char.escape', match: /\\./ }, subst('"')] },
      { scope: 'string', begin: /`/, end: /`|$/, contains: [{ scope: 'char.escape', match: /\\./ }, subst('`')] },
      { match: [/\b(task|type|agent)\b/, /\s+/, /[A-Za-z_][A-Za-z0-9_]*/], scope: { 1: 'keyword', 3: 'title.function' } },
      { scope: 'keyword.security', match: new RegExp('\\b(' + SECURITY.join('|') + ')\\b') },
      CALL,
      NUMBER
    ]
  };
}
// Prisma (schema.prisma): highlight.js no lo trae. Bloques model/enum/datasource/generator, tipos escalares,
// atributos @id/@@map, env("…"), comentarios // y ///.
function prismaGrammar(hljs) {
  return {
    name: 'Prisma', aliases: ['prisma'],
    keywords: {
      keyword: ['model', 'enum', 'type', 'view', 'datasource', 'generator'],
      built_in: ['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Unsupported'],
      literal: ['true', 'false', 'null']
    },
    contains: [
      hljs.COMMENT('///', '$'), hljs.COMMENT('//', '$'),
      { scope: 'string', begin: /"/, end: /"|$/, contains: [{ scope: 'char.escape', match: /\\./ }] },
      { match: [/\b(model|enum|type|view|datasource|generator)\b/, /\s+/, /[A-Za-z_]\w*/], scope: { 1: 'keyword', 3: 'title.class' } },
      { scope: 'attribute', match: /@@?[A-Za-z_][\w.]*/ },
      { scope: 'built_in', match: /\benv(?=\()/ },
      { scope: 'number', match: /\b\d+(\.\d+)?\b/ }
    ]
  };
}
if (typeof hljs !== 'undefined') { hljs.registerLanguage('synsema', synsemaGrammar); hljs.registerLanguage('prisma', prismaGrammar); }
