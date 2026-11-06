$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
 & "$repo/core/build.ps1"
 python "$repo/scripts/package.py" --binary "$repo/core/sing-box-min-linux-mipsle"
 if ($LASTEXITCODE -ne 0) {throw 'Packaging failed'}
} finally {Pop-Location}
