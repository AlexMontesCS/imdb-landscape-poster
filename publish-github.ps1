param(
  [string]$RepositoryName = "imdb-landscape-worker"
)

$ErrorActionPreference = "Stop"

foreach ($command in @("git", "gh")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $command. Install Git and GitHub CLI first."
  }
}

gh auth status | Out-Null
$GitHubLogin = gh api user --jq '.login'

if (-not (Test-Path ".git")) {
  git init -b main
}

if (-not (git config user.name)) {
  git config user.name $GitHubLogin
}
if (-not (git config user.email)) {
  git config user.email "$GitHubLogin@users.noreply.github.com"
}

git add .
$Changes = git diff --cached --name-only
if ($Changes) {
  git commit -m "Initial IMDb landscape Worker"
}

$Origin = git remote get-url origin 2>$null
if (-not $Origin) {
  gh repo create "$GitHubLogin/$RepositoryName" --public --source=. --remote=origin --push
} else {
  git push -u origin main
}

$RepositoryUrl = gh repo view --json url --jq '.url'
$DeployUrl = "https://deploy.workers.cloudflare.com/?url=$RepositoryUrl"

Write-Host ""
Write-Host "Repository: $RepositoryUrl"
Write-Host "Deploy:     $DeployUrl"
Start-Process $DeployUrl
