# release.ps1 - publishes a version of Atril on GitHub: the Windows .zip as a release asset. The site
# (synsema.github.io/atril) reads the newest release by itself: its number, date and title, the download link and
# the downloads of every release.
#
#   .\release.ps1 -Title "Panel de archivos, diffs y temas de dia y de noche"
#   .\release.ps1 -Title "..." -Notes notas.md      the release notes from a file (else GitHub writes them)
#   .\release.ps1 -Title "..." -DryRun              only builds the .zip in out\, publishes nothing
#
# The version is the daemon's (VERSION in src\atrild.syn); the tag is v<version>. It builds first
# (build.ps1). The .zip holds dist\, install.ps1 and "Instalar Atril.cmd", which runs the installer.
param([Parameter(Mandatory = $true)][string]$Title, [string]$Notes, [switch]$DryRun)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$m = Select-String -Path (Join-Path $root "src\atrild.syn") -Pattern '^let VERSION be "([^"]+)"'
if (-not $m) { throw "no VERSION in src\atrild.syn" }
$version = $m.Matches[0].Groups[1].Value
$tag = "v$version"

& (Join-Path $root "build.ps1")
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# the folder the .zip opens to
$out = Join-Path $root "out"
$name = "atril-$version-windows-x64"
$stage = Join-Path $out $name
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage "dist") | Out-Null
Copy-Item (Join-Path $root "dist\atr.exe"), (Join-Path $root "dist\atrild.exe") (Join-Path $stage "dist")
Copy-Item (Join-Path $root "install.ps1"), (Join-Path $root "LICENSE"), (Join-Path $root "NOTICE"), (Join-Path $root "THIRD_PARTY_NOTICES.md") $stage
Set-Content -Path (Join-Path $stage "Instalar Atril.cmd") -Encoding ASCII -Value @(
    "@echo off",
    "powershell -NoProfile -ExecutionPolicy Bypass -File ""%~dp0install.ps1""",
    "if errorlevel 1 pause"
)
$zip = Join-Path $out "$name.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path $stage -DestinationPath $zip
Write-Host "built $zip"

if ($DryRun) { exit 0 }

# the title is "v0.3.0 - <title>" with an em dash; written as a code so Windows PowerShell 5 reads this
# file right without a BOM
$ghArgs = @("release", "create", $tag, $zip, "--repo", "SYNSEMA/atril", "--title", "$tag $([char]0x2014) $Title")
if ($Notes) { $ghArgs += @("--notes-file", $Notes) } else { $ghArgs += "--generate-notes" }
gh @ghArgs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Host "published $tag"
