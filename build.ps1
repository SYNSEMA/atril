# build.ps1 — builds the Windows executables into dist\ with the Synsema engine (v0.6.44+).
#   atrild.exe  the daemon (no console, the window's files inside)
#   atr.exe     the command line
#   atril.exe   the same command line without a console: what the Start menu opens
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$icon = Join-Path $root "icon.svg"
New-Item -ItemType Directory -Force $dist | Out-Null

Push-Location (Join-Path $root "daemon")   # the static mount ./ui is resolved from here
try { synsema build atrild.syn -o (Join-Path $dist "atrild.exe") --serve --no-console --icon $icon } finally { Pop-Location }
synsema build (Join-Path $root "cli\atr.syn") -o (Join-Path $dist "atr.exe") --icon $icon
synsema build (Join-Path $root "cli\atr.syn") -o (Join-Path $dist "atril.exe") --no-console --icon $icon
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Get-ChildItem $dist *.exe | Format-Table Name, @{ n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
