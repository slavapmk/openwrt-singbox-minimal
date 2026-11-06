$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Portable Go; no system installation or PATH changes.
if (-not (Test-Path 'toolchain/go/bin/go.exe')) {
    Invoke-WebRequest 'https://go.dev/dl/go1.26.8.windows-amd64.zip' -OutFile 'go1.26.8.windows-amd64.zip'
    python -c "import zipfile; zipfile.ZipFile('go1.26.8.windows-amd64.zip').extractall('toolchain')"
}
if (-not (Test-Path 'source-inspect/sing-box-1.14.4/go.mod')) {
    Invoke-WebRequest 'https://codeload.github.com/SagerNet/sing-box/zip/refs/tags/v1.14.4' -OutFile 'sing-box-v1.14.4.zip'
    python -c "import zipfile; zipfile.ZipFile('sing-box-v1.14.4.zip').extractall('source-inspect')"
}
$sourceDir = 'source-inspect/sing-box-1.14.4'
New-Item -ItemType Directory -Force "$sourceDir/cmd/sing-box-min" | Out-Null
Copy-Item 'minimal-main.go' "$sourceDir/cmd/sing-box-min/main.go"
$env:GOPATH = "$PSScriptRoot/gopath"
$env:GOCACHE = "$PSScriptRoot/gocache"
$env:GOTOOLCHAIN = 'local'
$env:CGO_ENABLED = '0'
$env:GOOS = 'linux'
$env:GOARCH = 'mipsle'
$env:GOMIPS = 'softfloat'
& './toolchain/go/bin/go.exe' -C $sourceDir build -trimpath -buildvcs=false -tags with_quic -ldflags '-s -w -buildid= -checklinkname=0' -o '../../sing-box-min-linux-mipsle' ./cmd/sing-box-min
if ($LASTEXITCODE -ne 0) { throw 'Go build failed' }
Get-Item 'sing-box-min-linux-mipsle' | Select-Object Name,Length
Write-Output ('SHA256: ' + (Get-FileHash 'sing-box-min-linux-mipsle' -Algorithm SHA256).Hash)
