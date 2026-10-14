$ErrorActionPreference = "SilentlyContinue"

$targets = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -match 'telegram-main\.ts'
}

$pids = @($targets | Select-Object -ExpandProperty ProcessId -Unique)

foreach ($pidValue in $pids) {
    & taskkill /PID $pidValue /T /F | Out-Null
}

Start-Sleep -Seconds 1

$remaining = @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -match 'telegram-main\.ts'
})

[pscustomobject]@{
    Killed = $pids.Count
    Remaining = $remaining.Count
    RemainingPids = @($remaining | Select-Object -ExpandProperty ProcessId)
} | ConvertTo-Json -Depth 4
