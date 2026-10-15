// theme.js — Atril's colors. A theme is a JSON file: the ones that come with Atril live in ui/themes/
// (listed in BUILTIN), yours in ~/.atril/themes/*.json (the daemon serves them at /api/themes, no
// rebuild needed). See ui/themes/README.md for the format. A theme says only what it changes: the rest
// comes from the built-in theme of its kind (oscuro for dark, claro for light).
//
// What you choose: one theme always, or one for the day and one for the night, switched by the
// system's light/dark setting or by the hour. It is remembered in this browser (localStorage
// atril.theme), and the last colors applied are kept too, so the window opens in them with no flash.
// Loaded in <head>, before the page is drawn; app.js calls initThemes() once it is logged in.
"use strict";

const BUILTIN = ["oscuro", "neon", "claro", "papel", "contraste"];
const THEMES = {};                                 // id -> theme, as its JSON says
const themeStore = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// mode: fixed (id) | system | time; light and dark: the theme of each half
let themePick = Object.assign({ mode: "fixed", id: "oscuro", light: "claro", dark: "oscuro" }, themeStore.get("atril.theme", {}));
let themeNow = themeStore.get("atril.themeApplied", null);   // {id, kind, ui, terminal, contrast}

// a value goes into a CSS custom property: no url() (a theme is colors), no way out of the declaration
const safeValue = (v) => typeof v === "string" && v.length < 200 && !/url\(|[;{}<>]/i.test(v);

// what the theme before set and this one does not say goes back to app.css's default (a gap of the
// neon theme must not stay when you choose another)
let themeKeys = [];
function applyResolved(t) {
  const root = document.documentElement;
  for (const k of themeKeys) root.style.removeProperty("--" + k);
  themeKeys = [];
  for (const [k, v] of Object.entries(t.ui || {})) if (/^[a-z0-9-]+$/.test(k) && safeValue(v)) { root.style.setProperty("--" + k, v); themeKeys.push(k); }
  root.style.colorScheme = t.kind === "light" ? "light" : "dark";
  root.dataset.kind = t.kind === "light" ? "light" : "dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && t.ui && t.ui.bg) meta.content = t.ui.bg;
}
if (themeNow) applyResolved(themeNow);

// the colors a terminal gets (app.js makeTerm), and the contrast xterm keeps text at
function termTheme() { return (themeNow && themeNow.terminal) || { background: "#0c0c0d", foreground: "#e6e6ea", cursor: "#e6e6ea", selectionBackground: "#2f4a8a", selectionForeground: "#ffffff" }; }
function termContrast() { return (themeNow && themeNow.contrast) || 1; }

// a theme over the built-in one of its kind
function resolveTheme(id) {
  const t = THEMES[id];
  if (!t) return null;
  const kind = t.kind === "light" ? "light" : "dark";
  const base = THEMES[kind === "light" ? "claro" : "oscuro"] || {};
  const terminal = {};
  for (const [k, v] of Object.entries(Object.assign({}, base.terminal, t.terminal))) if (safeValue(v)) terminal[k] = v;
  const contrast = Number(t.contrast ?? base.contrast ?? 1);
  return { id, kind, ui: Object.assign({}, base.ui, t.ui), terminal, contrast: contrast >= 1 && contrast <= 21 ? contrast : 1 };
}

const isNight = () => { const h = new Date().getHours(); return h < 7 || h >= 19; };
const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function wantedTheme() {
  if (themePick.mode === "system") return systemDark() ? themePick.dark : themePick.light;
  if (themePick.mode === "time") return isNight() ? themePick.dark : themePick.light;
  return themePick.id;
}

function applyTheme() {
  const t = resolveTheme(wantedTheme()) || resolveTheme("oscuro");
  if (!t) return;
  themeNow = t;
  themeStore.set("atril.themeApplied", t);
  applyResolved(t);
  // the terminals already open take the new colors right away
  if (typeof terms !== "undefined") for (const x of terms.values()) { x.term.options.theme = t.terminal; x.term.options.minimumContrastRatio = t.contrast; }
  paintThemeMenu();
}

// ---- the menu: bottom of the sidebar
function paintThemeMenu() {
  const m = document.getElementById("themes");
  if (!m) return;
  const cur = wantedTheme();
  const row = (label, sub, on, f, cls) => {
    const b = document.createElement("button");
    b.className = (on ? "on " : "") + (cls || "");
    b.innerHTML = `<span class="ck">${on ? "✓" : ""}</span><span class="tl"></span><span class="ts"></span>`;
    b.querySelector(".tl").textContent = label;
    b.querySelector(".ts").textContent = sub || "";
    b.onclick = (e) => { e.stopPropagation(); f(); };
    m.append(b);
  };
  m.innerHTML = "";
  const h = document.createElement("div"); h.className = "th"; h.textContent = "Cambiar solo"; m.append(h);
  row("Como el sistema", `${THEMES[themePick.light]?.name || themePick.light} de día · ${THEMES[themePick.dark]?.name || themePick.dark} de noche`, themePick.mode === "system", () => setPick({ mode: "system" }));
  row("Según la hora", `${THEMES[themePick.light]?.name || themePick.light} de 7 a 19 h · ${THEMES[themePick.dark]?.name || themePick.dark} el resto`, themePick.mode === "time", () => setPick({ mode: "time" }));
  const h2 = document.createElement("div"); h2.className = "th"; h2.textContent = "Temas"; m.append(h2);
  const ids = Object.keys(THEMES).sort((a, b) => (BUILTIN.indexOf(a) + 1 || 99) - (BUILTIN.indexOf(b) + 1 || 99) || a.localeCompare(b));
  // a click always shows that theme (and leaves the automatic modes); it also becomes the theme of
  // its half, the one "Como el sistema" and "Según la hora" use for the day or for the night
  for (const id of ids) {
    const t = THEMES[id];
    const role = id === themePick.light && t.kind === "light" ? "de día" : id === themePick.dark && t.kind !== "light" ? "de noche" : "";
    row(t.name || id, (t.kind === "light" ? "claro" : "oscuro") + (id.startsWith("user:") ? " · tuyo" : "") + (role ? " · " + role : ""),
      themePick.mode === "fixed" && id === cur, () => setPick({ id }), "theme");
  }
  const f = document.createElement("div");
  f.className = "tf";
  f.textContent = "Los tuyos: un .json en ~/.atril/themes (ver ui/themes/README.md).";
  m.append(f);
}
// choosing a theme shows it always, and makes it the theme of its half for the automatic modes
function setPick(p) {
  if (p.id) { const t = THEMES[p.id]; p = { ...p, mode: "fixed" }; if (t) p[t.kind === "light" ? "light" : "dark"] = p.id; }
  themePick = Object.assign({}, themePick, p);
  themeStore.set("atril.theme", themePick);
  applyTheme();
}

async function loadThemes() {
  await Promise.all(BUILTIN.map(async (id) => {
    try { const r = await fetch("themes/" + id + ".json"); if (r.ok) THEMES[id] = await r.json(); } catch {}
  }));
  try {
    const r = await fetch("/api/themes", { credentials: "same-origin" });
    if (r.ok) for (const t of (await r.json()).themes || []) if (t && t.id && typeof t.ui === "object") THEMES["user:" + t.id] = t;
  } catch {}
}

async function initThemes() {
  const btn = document.getElementById("themebtn"), menu = document.getElementById("themes");
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) paintThemeMenu(); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#themes")) menu.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });
  await loadThemes();
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (themePick.mode === "system") applyTheme(); });
  setInterval(() => { if (themePick.mode === "time" && themeNow && themeNow.id !== wantedTheme()) applyTheme(); }, 60000);
}
