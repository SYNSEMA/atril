// files.js — the panel on the right: the files of the space on screen, with what git says changed
// (modified, new, deleted), a file read with its colors, and what changed in it (the diff since the
// last commit). Read only. It asks the daemon of the space's machine every few seconds while it is
// open, so what an agent writes shows up by itself. Uses app.js: $, api, base, spaceOf, current, store.
"use strict";

const FILES = {
  open: store.get("files", !document.documentElement.classList.contains("atril-phone")),   // on a phone it would cover the terminal
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
  if (open) { filesSync(true); } else closeViewer();
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
  if (!FILES.open) return;
  if (current !== FILES.sid) {
    FILES.sid = current;
    FILES.dirs = {}; FILES.changes = {}; FILES.repo = false; FILES.branch = null; FILES.error = ""; FILES.last = "";
    openDirs.clear();
    for (const d of store.get("filesOpen:" + current, [])) openDirs.add(d);
    if (VIEW && VIEW.sid !== current) closeViewer();
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

// ---- the viewer: over the terminals, in the middle; × or Esc goes back to them
async function openFile(path, mode) {
  VIEW = { sid: FILES.sid, path, mode, stamp: null };
  $("#viewer").hidden = false;
  $("#vbody").scrollTop = 0;
  paintFiles();
  await loadView(false);
}
function closeViewer() {
  if (!VIEW && $("#viewer").hidden) return;
  VIEW = null;
  $("#viewer").hidden = true;
  $("#vbody").innerHTML = "";
  if (FILES.open) paintFiles();
  const t = terms.get(lastTab[current]);
  if (t) requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
}
$("#vclose").onclick = closeViewer;
$("#vmode").onclick = (e) => { const m = e.target.dataset.m; if (!m || !VIEW || VIEW.mode === m) return; VIEW.mode = m; loadView(false); };
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("#viewer").hidden) return;
  if (!$("#palette").hidden || !$("#picker").hidden || !$("#conn").hidden || !$("#dialog").hidden) return;
  closeViewer();
});

async function loadView(keepScroll) {
  const v = VIEW;
  const sp = v && spaceOf(v.sid);
  if (!sp) return;
  const code = FILES.changes[v.path];
  const mode = code ? v.mode : "file";
  const body = $("#vbody");
  const top = body.scrollTop, left = body.scrollLeft;
  $("#vpath").textContent = v.path;
  $("#vpath").title = sp.path + "/" + v.path;
  const modes = $("#vmode");
  modes.hidden = !code;
  for (const b of modes.querySelectorAll("button")) b.classList.toggle("on", b.dataset.m === mode);
  const q = `?space=${encodeURIComponent(sp.key)}&path=${encodeURIComponent(v.path)}`;
  if (!keepScroll) { body.innerHTML = `<div class="fnote">leyendo…</div>`; $("#vmeta").textContent = ""; }
  try {
    let html, meta;
    if (mode === "diff" && code !== "??" && code !== "A") {
      const d = await api("GET", base(sp.mid) + "/files/diff" + q);
      if (VIEW !== v) return;
      [html, meta] = diffView(d.diff, v.path);
    } else {
      const f = await api("GET", base(sp.mid) + "/files/read" + q);
      if (VIEW !== v) return;
      if (f.gone) { html = `<div class="fnote">Este archivo ya no existe${code === "D" ? ": está borrado. «diff» muestra lo que tenía." : "."}</div>`; meta = ""; }
      else if (f.binary) { html = `<div class="fnote">No es texto (una imagen, una base de datos, un ejecutable…): no se puede mostrar acá.</div>`; meta = "binario · " + fmtSize(f.size); }
      else if (f.error) { html = `<div class="fnote err">${escH(f.error)}</div>`; meta = ""; }
      else if (mode === "diff") [html, meta] = newFileView(f.content, v.path, f.truncated);   // new: all of it is the change
      else [html, meta] = sourceView(f.content, v.path, f.truncated, f.size);
    }
    body.innerHTML = html;
    $("#vmeta").innerHTML = meta;
    if (keepScroll) { body.scrollTop = top; body.scrollLeft = left; }
  } catch (e) {
    if (VIEW !== v) return;
    body.innerHTML = `<div class="fnote err">${escH(e.message)}</div>`;
  }
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
