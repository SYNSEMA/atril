# install.ps1 — installs Atril for this Windows user (no admin).
#
#   .\install.ps1              copy dist\*.exe to %LOCALAPPDATA%\Atril, put `atr` on PATH,
#                              add Atril to the Start menu, start the daemon at sign-in, open it
#   .\install.ps1 -NoOpen      the same, without opening the window
#   .\install.ps1 -Uninstall   remove all of it (running sessions end)
#
# The executables come from dist\ next to this script (build them with .\build.ps1).
param([switch]$Uninstall, [switch]$NoOpen)
$ErrorActionPreference = "Stop"

$dest    = Join-Path $env:LOCALAPPDATA "Atril"
$src     = Join-Path $PSScriptRoot "dist"
$menu    = Join-Path ([Environment]::GetFolderPath("Programs")) "Atril.lnk"
$startup = Join-Path ([Environment]::GetFolderPath("Startup")) "Atril daemon.lnk"

function Stop-Atril {
    # whatever daemon answers on this machine (installed or run from the source), with its own key
    $conf = Join-Path $env:USERPROFILE ".atril\daemon.json"
    if (Test-Path $conf) {
        $key = (Get-Content $conf -Raw | ConvertFrom-Json).token
        try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7171/api/shutdown" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 3 | Out-Null } catch {}
    }
    Get-Process atrild -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

function Set-UserPath([string]$dir, [bool]$present) {
    $parts = @(([Environment]::GetEnvironmentVariable("Path", "User") -split ";") | Where-Object { $_ -and $_ -ne $dir })
    if ($present) { $parts += $dir }
    [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
    $env:Path = (($env:Path -split ";") | Where-Object { $_ -ne $dir }) -join ";"
    if ($present) { $env:Path += ";$dir" }
}

function New-Shortcut([string]$path, [string]$target, [string]$arguments, [string]$description) {
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    $s.TargetPath = $target
    $s.Arguments = $arguments
    $s.WorkingDirectory = $env:USERPROFILE
    $s.IconLocation = "$target,0"
    $s.Description = $description
    $s.Save()
}

if ($Uninstall) {
    Stop-Atril
    Remove-Item $menu, $startup -ErrorAction SilentlyContinue
    Set-UserPath $dest $false
    Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Atril removed. Your settings in ~\.atril were kept."
    exit 0
}

foreach ($f in "atr.exe", "atrild.exe") {
    if (-not (Test-Path (Join-Path $src $f))) { throw "missing dist\${f}: run .\build.ps1 first" }
}

Stop-Atril
New-Item -ItemType Directory -Force $dest | Out-Null
Remove-Item (Join-Path $dest "atril.exe") -ErrorAction SilentlyContinue   # older installs had a third one
Copy-Item (Join-Path $src "atr.exe"), (Join-Path $src "atrild.exe") $dest -Force
Set-UserPath $dest $true
# one program: from the Start menu it opens the window; at sign-in it only keeps the sessions
New-Shortcut $menu (Join-Path $dest "atrild.exe") "" "Your agents' terminals, alive on every machine"
New-Shortcut $startup (Join-Path $dest "atrild.exe") "--background" "Atril daemon: keeps your sessions alive"

& (Join-Path $dest "atr.exe") up
Write-Host ""
Write-Host "Atril is installed in $dest"
Write-Host "  - 'atr' works in any NEW terminal (atr run claude, atr ls, atr open)"
Write-Host "  - Atril is in the Start menu, and its daemon starts when you sign in"
if (-not $NoOpen) { Start-Process (Join-Path $dest "atrild.exe") }
