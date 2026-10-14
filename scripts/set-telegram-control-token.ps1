$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root ".env"
$StatePath = Join-Path $Root "runtime\telegram-controller-state.json"

$secure = Read-Host "Paste the NEW Telegram CONTROL bot token" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Token cannot be empty."
}

$lines = @()
if (Test-Path $EnvPath) {
    $lines = Get-Content $EnvPath
}

$found = $false
$updated = foreach ($line in $lines) {
    if ($line -match '^TELEGRAM_CONTROL_BOT_TOKEN=') {
        $found = $true
        "TELEGRAM_CONTROL_BOT_TOKEN=$token"
    } else {
        $line
    }
}
if (-not $found) {
    $updated += "TELEGRAM_CONTROL_BOT_TOKEN=$token"
}

Set-Content -Path $EnvPath -Value $updated -Encoding UTF8

$stateDir = Split-Path -Parent $StatePath
if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir | Out-Null
}
@{
    updateOffset = 0
    initialized = $false
} | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8

Write-Host "Control bot token stored locally in .env (gitignored)."
Write-Host "Controller state reset for the new bot."
Set-Location $Root
npm run telegram:validate
