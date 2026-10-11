// site.js — lo único que cambia solo en el sitio: la última versión publicada (número, fecha y título),
// las descargas de todas las versiones, los enlaces de descarga de cada sistema y las estrellas. Todo
// sale de la API pública de GitHub; sin servidor propio. La respuesta se guarda una hora en este
// navegador (la API deja 60 consultas por hora sin cuenta). Si falla, queda lo que dice el HTML.
"use strict";

(function () {
  var REPO = "SYNSEMA/atril";
  var API = "https://api.github.com/repos/" + REPO;
  var HOUR = 3600000;

  var $ = function (id) { return document.getElementById(id); };
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
    var lin = find(/linux.*\.(tar\.gz|tgz|zip)$/i);
    var mac = find(/(mac|darwin).*\.(tar\.gz|zip|dmg)$/i);
    if (win) $("dl-windows").href = win.browser_download_url;
    if (lin) $("dl-linux").href = lin.browser_download_url;
    if (mac) {
      var m = $("dl-macos");
      m.href = mac.browser_download_url;
      m.textContent = "macOS";
      m.classList.remove("off");
      m.removeAttribute("aria-disabled");
    }
  }).catch(function () {});

  // las estrellas, junto al enlace a GitHub
  cached("atril.repo", API).then(function (repo) {
    if (repo.stargazers_count > 0) $("stars").textContent = "★ " + fmtNum(repo.stargazers_count);
  }).catch(function () {});
})();
