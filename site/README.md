# Atril's site

The site of [Atril](https://github.com/SYNSEMA/atril). Static: HTML, CSS and one small script, published
by GitHub Pages from this folder.

What changes by itself (`site.js`, from GitHub's public API, cached one hour in each browser):

- the newest release: its number, date and title in the window at the top, and "Ver novedades"
- the download buttons: the asset of each system in that release, by name
  (`atril-<version>-windows-x64.zip`, `…-linux-x64.tar.gz`, `…-macos-….tar.gz`)
- the downloads of every release added up, and the stars next to the GitHub link
- the year in the footer

If the API does not answer (or the repository is still private), the page keeps what the HTML says.
A release is published from the Atril repository with `.\release.ps1 -Title "…"`.

## Publish

`.github/workflows/site.yml` publishes this folder to GitHub Pages on every push to `main` that
touches `site/`: <https://synsema.github.io/atril/>. The 404 page uses absolute paths under `/atril/`
(GitHub serves it at any missing path).

## Own domain (later)

1. Add a `CNAME` file here with the domain (for example `atril.dev`).
2. Change `https://synsema.github.io/atril/` to the domain in `robots.txt`, `sitemap.xml` and the
   `<head>` of `index.html` (canonical, `og:*`, `twitter:*`, JSON-LD), and `/atril/` to `/` in `404.html`.
3. Settings → Pages → Custom domain, and at the DNS: `A` records to 185.199.108.153,
   185.199.109.153, 185.199.110.153 and 185.199.111.153.

## Files

```
index.html        the page (SEO in <head>: description, canonical, Open Graph, JSON-LD)
style.css         the look: green phosphor screen, white chips, classic Mac windows
site.js           the live data from GitHub
404.html          a page that is not there
og.png            the card when the link is shared (1200×630)
favicon.svg, favicon-32.png, apple-touch-icon.png
img/atril-app.png the app, light theme
robots.txt, sitemap.xml, .nojekyll
```
