# Atril's site

The site of [Atril](https://github.com/SYNSEMA/atril). Static: HTML, CSS and one small script, published
by GitHub Pages from this folder.

What changes by itself (`site.js`, from GitHub's public API, cached one hour in each browser):

- the newest release: its number, date and title in the window at the top, and "Ver novedades"
- the Windows .zip link: that release's `atril-<version>-windows-x64.zip`
- the install tabs (Windows, Linux, macOS) open on the visitor's system
- the downloads of every release added up, and the stars next to the GitHub link
- the year in the footer

If the API does not answer (or the repository is still private), the page keeps what the HTML says.
A release is published from the Atril repository with `.\release.ps1 -Title "…"`.

## Publish

`.github/workflows/site.yml` publishes this folder to GitHub Pages on every push to `main` that
touches `site/`: <https://atril.dev/>. The 404 page uses absolute paths from `/` (GitHub serves it
at any missing path).

## Domain

`atril.dev` is set in Settings → Pages → Custom domain (with a workflow there is no `CNAME` file).
Its DNS is at Cloudflare, "DNS only" (grey cloud), so GitHub issues and renews the certificate:
`A` records for `atril.dev` to 185.199.108.153, 185.199.109.153, 185.199.110.153 and 185.199.111.153,
and `CNAME` `www` to `synsema.github.io`. The old address, `synsema.github.io/atril/`, redirects
here, so the install commands already out there keep working.

## Files

```
index.html        the page (SEO in <head>: description, canonical, Open Graph, JSON-LD)
style.css         the look: green phosphor screen, white chips, classic Mac windows
site.js           the live data from GitHub, and the copy button
install.ps1       Windows from the terminal: irm https://atril.dev/install.ps1 | iex
install.sh        Linux and macOS: curl -fsSL https://atril.dev/install.sh | sh
404.html          a page that is not there
og.png            the card when the link is shared (1200×630)
favicon.svg, favicon-32.png, apple-touch-icon.png
img/atril-app.png the app, light theme
robots.txt, sitemap.xml, .nojekyll
```
