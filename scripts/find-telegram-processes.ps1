$ErrorActionPreference = "Stop"
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -match 'telegram-main' -or
      $_.CommandLine -match 'telegram-controller' -or
      $_.CommandLine -match 'prysm-gacm-mcp'
    )
  } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine |
  ConvertTo-Json -Depth 4
