$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root ".env"

$secure = Read-Host "Paste the existing Telegram bot token" -AsSecureString
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
    if ($line -match '^TELEGRAM_BOT_TOKEN=') {
        $found = $true
        "TELEGRAM_BOT_TOKEN=$token"
    } else {
        $line
    }
}
if (-not $found) {
    $updated += "TELEGRAM_BOT_TOKEN=$token"
}

Set-Content -Path $EnvPath -Value $updated -Encoding UTF8
Write-Host "Token stored locally in .env (gitignored)."
Set-Location $Root
npm run telegram:validate
