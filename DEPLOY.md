# Deployment guide

## Browser-only route

1. Open `START-HERE.html`.
2. Use its link to create a public GitHub repository named `imdb-landscape-worker`.
3. Unzip this package and upload all files to the repository root.
4. Copy the repository URL, such as `https://github.com/alex/imdb-landscape-worker`.
5. Paste it into `START-HERE.html`.
6. Click **Deploy to Cloudflare**.

The repository must be public for Cloudflare's deployment template to clone it.

## Automatic publishing scripts

The included scripts create and push the public GitHub repository, then open the Cloudflare deployment page.

### macOS or Linux

```bash
chmod +x publish-github.sh
./publish-github.sh
```

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass
./publish-github.ps1
```

Requirements: Git and the GitHub CLI (`gh`), already signed in with `gh auth login`.

## Direct Wrangler route

```bash
npm install
npm test
npm run deploy
```
