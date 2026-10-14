param(
  [Parameter(Mandatory = $true)][ValidateSet("prysm", "gacm", "sandbox")][string]$Project,
  [Parameter(Mandatory = $true)][string]$Tranche,
  [string]$Role,
  [string]$RunId
)

$arguments = @("run", "workspace:resolve", "--", "--project", $Project, "--tranche", $Tranche)
if ($Role) { $arguments += @("--role", $Role) }
if ($RunId) { $arguments += @("--run-id", $RunId) }

& npm @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Governed workspace resolution failed closed."
}
