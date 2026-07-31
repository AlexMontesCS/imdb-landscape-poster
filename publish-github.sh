#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-imdb-landscape-worker}"

for command_name in git gh; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name"
    echo "Install Git and GitHub CLI, then run this script again."
    exit 1
  fi
done

gh auth status >/dev/null
GH_LOGIN="$(gh api user --jq '.login')"

if [ ! -d .git ]; then
  git init -b main
fi

git config user.name "$(git config user.name || echo "$GH_LOGIN")"
git config user.email "$(git config user.email || echo "$GH_LOGIN@users.noreply.github.com")"

git add .
if ! git diff --cached --quiet; then
  git commit -m "Initial IMDb landscape Worker"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$GH_LOGIN/$REPO_NAME" --public --source=. --remote=origin --push
else
  git push -u origin main
fi

REPO_URL="$(gh repo view --json url --jq '.url')"
DEPLOY_URL="https://deploy.workers.cloudflare.com/?url=$REPO_URL"

echo
echo "Repository: $REPO_URL"
echo "Deploy:     $DEPLOY_URL"

if command -v open >/dev/null 2>&1; then
  open "$DEPLOY_URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$DEPLOY_URL"
fi
