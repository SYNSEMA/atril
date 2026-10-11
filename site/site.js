// site.js — lo único que cambia solo en el sitio: la última versión publicada (número, fecha y título),
// las descargas de todas las versiones, el .zip de Windows y las estrellas; y las pestañas de sistema. Todo
// sale de la API pública de GitHub; sin servidor propio. La respuesta se guarda una hora en este
// navegador (la API deja 60 consultas por hora sin cuenta). Si falla, queda lo que dice el HTML.
"use strict";

(function () {
  var REPO = "SYNSEMA/atril";
  var API = "https://api.github.com/repos/" + REPO;
  var HOUR = 3600000;

  var $ = function (id) { return document.getElementById(id); };
  // pestañas de sistema: muestran el comando de cada uno; abre la de quien mira
  var tabs = document.querySelectorAll(".tab"), panels = document.querySelectorAll(".os-panel");
  function showOs(os) {
    Array.prototype.forEach.call(tabs, function (t) { t.setAttribute("aria-selected", String(t.dataset.os === os)); });
    Array.prototype.forEach.call(panels, function (p) { p.hidden = p.dataset.os !== os; });
  }
  Array.prototype.forEach.call(tabs, function (t) { t.onclick = function () { showOs(t.dataset.os); }; });
  var ua = navigator.userAgent;
  showOs(location.hash === "#linux" ? "linux" : /Mac OS X|Macintosh/.test(ua) && !/Mobile/.test(ua) ? "macos" : /Linux|X11|CrOS/.test(ua) && !/Android/.test(ua) ? "linux" : "windows");
  window.addEventListener("hashchange", function () { if (location.hash === "#linux") showOs("linux"); });

  // copiar los comandos de instalación
  Array.prototype.forEach.call(document.querySelectorAll(".cmd .copy"), function (btn) {
    if (!navigator.clipboard) return;
    btn.onclick = function () {
      navigator.clipboard.writeText(btn.previousElementSibling.textContent).then(function () {
        btn.textContent = "copiado ✓";
        setTimeout(function () { btn.textContent = "copiar"; }, 2000);
      });
    };
  });

  var year = $("year");
  if (year) year.textContent = new Date().getFullYear();

  function cached(key, url) {
    try {
      var c = JSON.parse(localStorage.getItem(key));
      if (c && Date.now() - c.at < HOUR) return Promise.resolve(c.data);
    } catch (e) {}
    return fetch(url, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data: data })); } catch (e) {}
        return data;
      });
  }

  var fmtDate = function (iso) {
    return new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }).replace(".", "");
  };
  var fmtNum = function (n) { return n.toLocaleString("es"); };

  // las versiones publicadas: la más nueva para las novedades y los enlaces, todas para el contador
  cached("atril.releases", API + "/releases?per_page=100").then(function (list) {
    var rels = list.filter(function (r) { return !r.draft && !r.prerelease; });
    if (!rels.length) return;
    var last = rels[0];

    $("rel-date").textContent = fmtDate(last.published_at);
    $("rel-ver").textContent = String(last.tag_name).replace(/^v/, "");
    if (last.name && last.name !== last.tag_name) $("rel-title").textContent = last.name.replace(/^v?[\d.]+\s*[—–:-]\s*/, "");
    $("rel-link").href = last.html_url;

    var total = 0;
    rels.forEach(function (r) { (r.assets || []).forEach(function (a) { total += a.download_count || 0; }); });
    if (total > 0) $("dl-count").textContent = fmtNum(total) + " descargas ▪ ";

    // el archivo de cada sistema, por su nombre: atril-0.3.0-windows.zip, atril-0.3.0-linux.tar.gz…
    // si hay varios para un sistema, el de 64 bits
    var find = function (re) {
      var all = (last.assets || []).filter(function (a) { return re.test(a.name); });
      return all.filter(function (a) { return /(x64|amd64|x86_64|arm64)/i.test(a.name); })[0] || all[0];
    };
    var win = find(/windows.*\.(zip|exe|msi)$/i);
    if (win) $("dl-windows").href = win.browser_download_url;
  }).catch(function () {});

  // las estrellas, junto al enlace a GitHub
  cached("atril.repo", API).then(function (repo) {
    if (repo.stargazers_count > 0) $("stars").textContent = "★ " + fmtNum(repo.stargazers_count);
  }).catch(function () {});
})();
