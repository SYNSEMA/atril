// star.js — once in a while, a small note in a corner: "¿Te gusta Atril?" with a button that stars
// the repository on GitHub. The daemon does it with the GitHub CLI when it is signed in on this
// machine (one click); otherwise the repository's page opens and the star is given there.
//
// When: from the third day of use, never twice in a week ("Después"), never again once starred or
// after "no preguntar más". Remembered in this browser (localStorage atril.star). It never takes
// the focus away from the terminal. app.js calls initStar() once it is logged in.
"use strict";

const STAR_FIRST_DAYS = 3;
const STAR_SNOOZE_DAYS = 7;
const DAY = 86400000;

function starState() {
  try { return JSON.parse(localStorage.getItem("atril.star")) || {}; } catch { return {}; }
}
function setStarState(p) {
  const s = Object.assign(starState(), p);
  try { localStorage.setItem("atril.star", JSON.stringify(s)); } catch {}
  return s;
}

async function initStar() {
  let s = starState();
  if (!s.first) s = setStarState({ first: Date.now() });
  if (s.done || Date.now() - s.first < STAR_FIRST_DAYS * DAY || Date.now() < (s.next || 0)) return;
  let info = { starred: null, url: "https://github.com/SYNSEMA/atril" };
  try { info = await api("GET", "/api/star"); } catch {}
  if (info.starred === true) { setStarState({ done: true }); return; }
  showStar(info.url, Math.floor((Date.now() - s.first) / DAY));
}

function showStar(url, days) {
  if (document.getElementById("star")) return;
  const box = document.createElement("div");
  box.id = "star";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Una estrella para Atril");
  box.innerHTML = `
    <button class="sx" title="Cerrar">×</button>
    <div class="sh"><span class="si">★</span> ¿Te gusta Atril?</div>
    <p></p>
    <div class="sr">
      <button class="go">★ Dar estrella</button>
      <button class="later">Después</button>
      <button class="never">no preguntar más</button>
    </div>`;
  box.querySelector("p").textContent = `Lo usás hace ${days} días. Una estrella en GitHub ayuda a que más gente lo encuentre.`;
  const close = () => box.remove();
  const later = () => { setStarState({ next: Date.now() + STAR_SNOOZE_DAYS * DAY }); close(); };
  box.querySelector(".sx").onclick = later;
  box.querySelector(".later").onclick = later;
  box.querySelector(".never").onclick = () => { setStarState({ done: true }); close(); };
  box.querySelector(".go").onclick = async (e) => {
    const row = box.querySelector(".sr");
    e.target.disabled = true;
    e.target.textContent = "★ …";
    let r = { starred: false, url };
    try { r = await api("POST", "/api/star"); } catch {}
    setStarState({ done: true });
    if (r.starred) {
      row.innerHTML = `<span class="ok">★ ¡Gracias! Ya tiene tu estrella.</span>`;
    } else {
      // no GitHub CLI here: the page, where the star is one more click
      window.open(r.url || url, "_blank", "noopener");
      row.innerHTML = `<span class="ok">Se abrió GitHub: apretá ★ Star arriba a la derecha. ¡Gracias!</span>`;
    }
    setTimeout(close, 6000);
  };
  document.body.append(box);
}
