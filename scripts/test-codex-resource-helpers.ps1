$ErrorActionPreference = "Continue"
$base = "C:\Users\kulba\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex-resources"
$names = @("codex-command-runner.exe","codex-windows-sandbox-setup.exe")
foreach ($name in $names) {
  $p = Join-Path $base $name
  Write-Output "=== $name ==="
  Write-Output ("exists=" + (Test-Path -LiteralPath $p))
  if (Test-Path -LiteralPath $p) {
    $item = Get-Item -LiteralPath $p
    Write-Output ("length=" + $item.Length)
    try {
      & $p --help 2>&1 | Select-Object -First 12 | ForEach-Object { Write-Output $_ }
      Write-Output ("exit=" + $LASTEXITCODE)
    } catch {
      Write-Output ("launch_error=" + $_.Exception.Message)
    }
  }
}
