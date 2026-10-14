$ErrorActionPreference = "Stop"
$matches = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $_.CommandLine -match 'C:\\Users\\kulba\\Desktop\\prysm-gacm-mcp' -and
  ($_.CommandLine -match 'telegram-main\.ts' -or $_.CommandLine -match 'npm run telegram')
}
$pids = @($matches | Select-Object -ExpandProperty ProcessId -Unique | Sort-Object -Descending)
foreach ($pidValue in $pids) {
  try { Stop-Process -Id $pidValue -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Milliseconds 500
$remaining = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $_.CommandLine -match 'C:\\Users\\kulba\\Desktop\\prysm-gacm-mcp' -and
  ($_.CommandLine -match 'telegram-main\.ts' -or $_.CommandLine -match 'npm run telegram')
})
[pscustomobject]@{
  Stopped = $pids.Count
  Remaining = $remaining.Count
} | ConvertTo-Json
