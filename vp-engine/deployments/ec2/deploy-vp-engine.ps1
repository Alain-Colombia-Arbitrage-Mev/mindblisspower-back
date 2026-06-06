param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "ec2-user",
  [string]$KeyPath = "",
  [string]$EnvFile = "",
  [string]$RemoteRoot = "/opt/mindbliss/vp-engine",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Timestamp = Get-Date -Format "yyyyMMddHHmmss"
$BuildDir = Join-Path $ProjectRoot "bin"
$Binary = Join-Path $BuildDir "vp-engine-linux-arm64"
$ServiceFile = Join-Path $PSScriptRoot "mindbliss-vp-engine.service"

New-Item -ItemType Directory -Force $BuildDir | Out-Null

$oldCgo = $env:CGO_ENABLED
$oldGoos = $env:GOOS
$oldGoarch = $env:GOARCH

Push-Location $ProjectRoot
try {
  if (-not $SkipTests) {
    go test ./...
  }

  $env:CGO_ENABLED = "0"
  $env:GOOS = "linux"
  $env:GOARCH = "arm64"
  go build -trimpath -ldflags="-s -w" -o $Binary ./cmd/vp-engine
}
finally {
  $env:CGO_ENABLED = $oldCgo
  $env:GOOS = $oldGoos
  $env:GOARCH = $oldGoarch
  Pop-Location
}

$SshArgs = @()
if ($KeyPath) {
  $SshArgs += @("-i", $KeyPath)
}
$SshArgs += @("$User@$HostName")

function Invoke-Remote {
  param([Parameter(Mandatory = $true)][string]$Command)
  ssh @SshArgs $Command
}

function Copy-Remote {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $ScpArgs = @()
  if ($KeyPath) {
    $ScpArgs += @("-i", $KeyPath)
  }
  $ScpArgs += @($Source, "$User@$HostName`:$Destination")
  scp @ScpArgs
}

$ReleaseDir = "$RemoteRoot/releases/$Timestamp"

Invoke-Remote "id -u mindbliss >/dev/null 2>&1 || sudo useradd --system --create-home --shell /sbin/nologin mindbliss"
Invoke-Remote "sudo install -d -o mindbliss -g mindbliss $ReleaseDir $RemoteRoot /var/log/vp-engine && sudo install -d -m 0750 -o root -g mindbliss /etc/vp-engine /etc/vp-engine/tls"

Copy-Remote $Binary "/tmp/vp-engine-linux-arm64"
Copy-Remote $ServiceFile "/tmp/mindbliss-vp-engine.service"

if ($EnvFile) {
  Copy-Remote $EnvFile "/tmp/vp-engine-app.env"
  Invoke-Remote "sudo install -m 0640 -o root -g mindbliss /tmp/vp-engine-app.env /etc/vp-engine/app.env"
}

Invoke-Remote "sudo install -m 0755 -o mindbliss -g mindbliss /tmp/vp-engine-linux-arm64 $ReleaseDir/vp-engine"
Invoke-Remote "sudo ln -sfn $ReleaseDir $RemoteRoot/current && sudo install -m 0644 /tmp/mindbliss-vp-engine.service /etc/systemd/system/mindbliss-vp-engine.service"
Invoke-Remote "sudo systemctl daemon-reload && sudo systemctl enable mindbliss-vp-engine && sudo systemctl restart mindbliss-vp-engine"
Invoke-Remote "sleep 2 && curl -fsS http://127.0.0.1:9090/health"

Write-Host "vp-engine deployed to $HostName at $ReleaseDir"
