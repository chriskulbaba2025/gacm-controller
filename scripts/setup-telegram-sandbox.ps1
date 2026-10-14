$ErrorActionPreference = "Stop"
$Repo = "C:\Users\kulba\Desktop\telegram-control-sandbox"
Set-Location $Repo

if (-not (Test-Path ".git")) {
    git init | Out-Host
}

git add README.md

$commitCount = [int](git rev-list --count --all)
if ($commitCount -eq 0) {
    git commit -m "Initialize-telegram-control-sandbox" | Out-Host
}

$remoteNames = @(git remote)
if ($remoteNames -notcontains "origin") {
    gh repo create chriskulbaba2025/telegram-control-sandbox --private --source . --remote origin --push
} else {
    git push -u origin HEAD
}

Write-Host "=== LOCAL ==="
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --porcelain=v1
git remote get-url origin

Write-Host "=== GITHUB ==="
gh repo view chriskulbaba2025/telegram-control-sandbox --json nameWithOwner,visibility,url,defaultBranchRef
