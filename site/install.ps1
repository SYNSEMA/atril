# Atril for Windows, from the terminal: the newest release, installed for this user (no admin).
#
#   irm https://synsema.github.io/atril/install.ps1 | iex
#
# Downloaded by PowerShell, the files carry no "came from the internet" mark, so Windows does not
# stop them with SmartScreen warnings. It checks the .zip against the SHA-256 that GitHub publishes
# for it, unzips it to a temporary folder and runs the install.ps1 inside (the same one as the
# "Instalar Atril" of the .zip). Source: https://github.com/SYNSEMA/atril
& {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is many times slower with the bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $rel = Invoke-RestMethod "https://api.github.com/repos/SYNSEMA/atril/releases/latest" -Headers @{ "User-Agent" = "atril-install" }
    $asset = $rel.assets | Where-Object { $_.name -match "windows.*\.zip$" } | Select-Object -First 1
    if (-not $asset) { throw "Atril $($rel.tag_name) has no Windows download" }

    $tmp = Join-Path $env:TEMP ("atril-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory $tmp | Out-Null
    try {
        $zip = Join-Path $tmp $asset.name
        Write-Host "Atril $($rel.tag_name): bajando $($asset.name)..."
        Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing

        if ($asset.digest -match "^sha256:([0-9a-f]{64})$") {
            $want = $Matches[1]
            $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
            if ($got -ne $want) { throw "the download does not match its SHA-256 ($got, expected $want): not installed" }
            Write-Host "verificado (SHA-256)"
        }

        Expand-Archive $zip -DestinationPath $tmp
        $inst = Get-ChildItem $tmp -Recurse -Filter install.ps1 | Select-Object -First 1
        if (-not $inst) { throw "install.ps1 is not in $($asset.name)" }
        # a process of its own with the policy for this run only: the machine's policy is left alone
        & powershell -NoProfile -ExecutionPolicy Bypass -File $inst.FullName
        if ($LASTEXITCODE) { throw "the installer stopped with code $LASTEXITCODE" }
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
