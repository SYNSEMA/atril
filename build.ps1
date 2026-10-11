# build.ps1 — builds the Windows executables into dist\ with the Synsema engine (v0.6.44+).
#   atrild.exe  the daemon, no console, the window's files inside. It is also the Start menu entry:
#               with no argument it opens the window (or shows the one already open)
#   atr.exe     the command line
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$icon = Join-Path $root "icon.svg"
New-Item -ItemType Directory -Force $dist | Out-Null
Remove-Item (Join-Path $dist "atril.exe") -ErrorAction SilentlyContinue   # older builds had a third one

Push-Location (Join-Path $root "src")   # the static mount ./ui and the modules resolve from here
try {
    # atr.syn and install.sh travel inside: "Conectar máquina" installs Atril on a machine that has none
    synsema build atrild.syn -o (Join-Path $dist "atrild.exe") --serve --no-console --icon $icon --include atr.syn --include install.sh
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    synsema build atr.syn -o (Join-Path $dist "atr.exe") --icon $icon
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally { Pop-Location }
Get-ChildItem $dist *.exe | Format-Table Name, @{ n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
