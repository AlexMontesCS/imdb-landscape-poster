# IMDb #1 Landscape Image — Cloudflare Worker

A keyless Cloudflare Worker that returns a landscape image for IMDb's current #1 popular movie or TV show.

> Before using the button, replace `YOUR_GITHUB_USERNAME` in the link below with your GitHub username. Keep the public repository name as `imdb-landscape-worker`, or replace that part too.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_USERNAME/imdb-landscape-worker)

## Endpoints

- `/movie` — displays/proxies the current #1 movie landscape image
- `/tv` — displays/proxies the current #1 TV landscape image
- `/movie?json=1` — movie metadata as JSON
- `/tv?json=1` — TV metadata as JSON
- `/movie?url=1` — plain upstream image URL
- `/tv?url=1` — plain upstream image URL

Use it directly in HTML:

```html
<img src="https://YOUR-WORKER.workers.dev/movie" alt="IMDb #1 movie">
<img src="https://YOUR-WORKER.workers.dev/tv" alt="IMDb #1 TV show">
```

## One-button deployment

1. Create a **public** GitHub repository.
2. Upload this project's files to the repository root.
3. Edit this README and replace `YOUR_GITHUB_USERNAME` in the button link.
4. Click **Deploy to Cloudflare** above.
5. Sign in to Cloudflare and approve deployment.

Cloudflare clones the repository, configures the Worker, and sets up builds for later pushes.

## Local deployment

```bash
npm install
npm test
npm run deploy
```

## Notes

- No API key, database, secret, KV namespace, or other Cloudflare resource is required.
- Results are cached for six hours.
- The Worker chooses a high-resolution wide image, preferring still frames near 16:9.
- It uses IMDb's undocumented website GraphQL endpoint rather than IMDb's supported commercial API. IMDb may change or block this endpoint at any time.
- Review IMDb's terms and image rights before using this in a public or commercial product.
