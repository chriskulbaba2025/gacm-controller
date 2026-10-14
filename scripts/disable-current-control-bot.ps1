$ErrorActionPreference = "Stop"

$startup = "C:\Users\kulba\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\PRYSM-GACM-Telegram-Controller.cmd"
if (Test-Path $startup) {
    Remove-Item $startup -Force
}

$envPath = "C:\Users\kulba\Desktop\prysm-gacm-mcp\.env"
if (Test-Path $envPath) {
    $content = Get-Content $envPath
    $content = $content -replace '^TELEGRAM_BOT_TOKEN=', 'TELEGRAM_ALERT_BOT_TOKEN='
    Set-Content -Path $envPath -Value $content -Encoding UTF8
}

Write-Output "AUTO_START_DISABLED"
Write-Output "OLD_CONTROL_TOKEN_DISABLED"
