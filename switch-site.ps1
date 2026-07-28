# Swap which site variant is live at the repo root.
# Usage: .\switch-site.ps1 gamekey     (or)     .\switch-site.ps1 anticheat
#
# Both full site variants live permanently in site-<name>\ folders.
# This script clears everything at the root EXCEPT .git, the site-*
# folders, and the switch scripts, then copies the chosen variant's
# files into the root. Cloudflare (or GitHub Pages) always serves
# whatever is currently sitting at the root, so after this runs +
# you commit + push, the swap goes live.

param(
    [Parameter(Mandatory = $false)]
    [string]$Target
)

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$KeepAlways = @('.git', 'switch-site.ps1', 'switch-site.sh')

if (-not $Target -or -not (Test-Path "site-$Target")) {
    Write-Host "Usage: .\switch-site.ps1 <site-name>"
    Write-Host "Available site variants:"
    Get-ChildItem -Directory -Filter 'site-*' | ForEach-Object {
        Write-Host "  - $($_.Name -replace '^site-', '')"
    }
    exit 1
}

$VariantDir = "site-$Target"

Write-Host "Switching live site to: $Target"

Get-ChildItem -Force | Where-Object {
    $_.Name -notin $KeepAlways -and $_.Name -notlike 'site-*'
} | Remove-Item -Recurse -Force

Get-ChildItem -Force -Path $VariantDir | ForEach-Object {
    Copy-Item $_.FullName -Destination $RepoRoot -Recurse -Force
}

Write-Host "Done. Root now serves the '$Target' site."
Write-Host "Review with: git status"
Write-Host 'Then commit + push to deploy:'
Write-Host "  git add -A; git commit -m `"switch: $Target`"; git push"
