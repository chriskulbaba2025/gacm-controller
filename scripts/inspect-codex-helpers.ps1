$base = "C:\Users\kulba\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin"
$names = @(
  "codex.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "codex-code-mode-host.exe"
)
foreach ($name in $names) {
  $p = Join-Path $base $name
  Write-Output "=== $name ==="
  Write-Output ("Test-Path: " + (Test-Path -LiteralPath $p))
  try {
    $i = Get-Item -LiteralPath $p -Force
    Write-Output ("Length: " + $i.Length)
    Write-Output ("Attributes: " + $i.Attributes)
    Write-Output ("Version: " + $i.VersionInfo.FileVersion)
    $sig = Get-AuthenticodeSignature -LiteralPath $p
    Write-Output ("Signature: " + $sig.Status)
  } catch {
    Write-Output ("ERROR: " + $_.Exception.Message)
  }
}
