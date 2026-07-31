const GRAPHQL_ENDPOINTS = [
  "https://api.graphql.imdb.com/",
  "https://caching.graphql.imdb.com/",
];

const CACHE_SECONDS = 6 * 60 * 60;
const BROWSER_CACHE_SECONDS = 60 * 60;

const CHARTS = {
  "/movie": {
    chartType: "MOST_POPULAR_MOVIES",
    label: "MOVIE",
  },
  "/tv": {
    chartType: "MOST_POPULAR_TV_SHOWS",
    label: "TV SHOW",
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(
        { error: "Method not allowed. Use GET or HEAD." },
        405,
        { Allow: "GET, HEAD" },
      );
    }

    if (url.pathname === "/") {
      return jsonResponse({
        service: "IMDb #1 landscape poster card",
        endpoints: {
          movie: "/movie",
          tv: "/tv",
          movieOriginalPoster: "/movie?raw=1",
          tvOriginalPoster: "/tv?raw=1",
          movieMetadata: "/movie?json=1",
          tvMetadata: "/tv?json=1",
        },
        note: "The default endpoint builds a 16:9 card from IMDb's primary poster, so it looks like poster artwork rather than a random still frame.",
      });
    }

    const chart = CHARTS[url.pathname];
    if (!chart) {
      return jsonResponse({ error: "Not found. Use /movie or /tv." }, 404);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return request.method === "HEAD" ? toHeadResponse(cached) : cached;
    }

    try {
      const item = await getNumberOnePoster(chart);

      let response;
      if (url.searchParams.get("json") === "1") {
        response = jsonResponse({
          rank: item.rank,
          imdbId: item.id,
          title: item.title,
          category: item.label,
          poster: item.poster.url,
          posterWidth: item.poster.width,
          posterHeight: item.poster.height,
          imdbUrl: `https://www.imdb.com/title/${item.id}/`,
          landscapeEndpoint: url.pathname,
          originalPosterEndpoint: `${url.pathname}?raw=1`,
        });
      } else if (url.searchParams.get("url") === "1") {
        response = new Response(item.poster.url + "\n", {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else if (url.searchParams.get("raw") === "1") {
        response = await proxyOriginalPoster(item);
      } else {
        response = await renderLandscapePosterCard(item);
      }

      response = withPublicCacheHeaders(response);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      return request.method === "HEAD" ? toHeadResponse(response) : response;
    } catch (error) {
      console.error(error);
      return jsonResponse(
        {
          error: "Could not fetch the current IMDb poster.",
          detail: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  },
};

async function getNumberOnePoster(chart) {
  const query = `
    query {
      chartTitles(first: 1, chart: { chartType: ${chart.chartType} }) {
        edges {
          currentRank
          node {
            id
            titleText { text }
            primaryImage { url width height type }
          }
        }
      }
    }
  `;

  const data = await fetchIMDbGraphQL(query);
  const edge = data?.chartTitles?.edges?.[0];
  const title = edge?.node;
  const poster = title?.primaryImage;

  if (!title?.id) {
    throw new Error("IMDb returned no #1 chart title.");
  }

  if (!isUsableImage(poster)) {
    throw new Error(`IMDb returned no primary poster for ${title.titleText?.text ?? title.id}.`);
  }

  return {
    rank: edge.currentRank ?? 1,
    id: title.id,
    title: title.titleText?.text ?? title.id,
    label: chart.label,
    poster,
  };
}

async function fetchIMDbGraphQL(query) {
  const errors = [];

  for (const endpoint of GRAPHQL_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://www.imdb.com",
          Referer: "https://www.imdb.com/",
          "User-Agent": "Mozilla/5.0 IMDbLandscapePosterWorker/1.2",
          "x-imdb-client-name": "imdb-web-next-localized",
          "x-imdb-user-language": "en-US",
          "x-imdb-user-country": "US",
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        throw new Error(`${endpoint} returned HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((item) => item.message).join("; "));
      }
      if (!payload.data) {
        throw new Error("IMDb returned no data object.");
      }

      return payload.data;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(errors.join(" | "));
}

async function fetchPoster(item) {
  const response = await fetch(item.poster.url, {
    headers: {
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      Referer: `https://www.imdb.com/title/${item.id}/`,
      "User-Agent": "Mozilla/5.0 IMDbLandscapePosterWorker/1.2",
    },
    cf: {
      cacheEverything: true,
      cacheTtl: CACHE_SECONDS,
      cacheTtlByStatus: {
        "200-299": CACHE_SECONDS,
        "404": 60,
        "500-599": 0,
      },
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`IMDb image server returned HTTP ${response.status}.`);
  }

  return response;
}

async function proxyOriginalPoster(item) {
  const upstream = await fetchPoster(item);
  const headers = new Headers();
  const contentType = upstream.headers.get("Content-Type") ?? "image/jpeg";
  const extension = imageExtension(contentType);

  headers.set("Content-Type", contentType);
  headers.set(
    "Content-Disposition",
    `inline; filename="${slugify(item.title)}-poster.${extension}"`,
  );
  addItemHeaders(headers, item);

  return new Response(upstream.body, { status: 200, headers });
}

async function renderLandscapePosterCard(item) {
  const upstream = await fetchPoster(item);
  const contentType = upstream.headers.get("Content-Type") ?? "image/jpeg";
  const posterBytes = await upstream.arrayBuffer();
  const posterDataUrl = `data:${contentType};base64,${arrayBufferToBase64(posterBytes)}`;

  const canvasWidth = 1600;
  const canvasHeight = 900;
  const maxPosterWidth = 520;
  const maxPosterHeight = 760;
  const posterRatio = item.poster.width / item.poster.height;

  let posterWidth = Math.min(maxPosterWidth, maxPosterHeight * posterRatio);
  let posterHeight = posterWidth / posterRatio;
  if (posterHeight > maxPosterHeight) {
    posterHeight = maxPosterHeight;
    posterWidth = posterHeight * posterRatio;
  }

  const posterX = 150 + (maxPosterWidth - posterWidth) / 2;
  const posterY = (canvasHeight - posterHeight) / 2;
  const titleStyle = titleTypography(item.title);
  const titleLines = wrapTitle(item.title, titleStyle.maxCharacters, 3);
  const titleStartY = 365 - ((titleLines.length - 1) * titleStyle.lineHeight) / 2;

  const titleText = titleLines
    .map(
      (line, index) =>
        `<tspan x="760" y="${titleStartY + index * titleStyle.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" role="img" aria-label="${escapeXml(item.title)} landscape poster">
  <defs>
    <image id="poster-source" href="${posterDataUrl}" width="${item.poster.width}" height="${item.poster.height}"/>
    <symbol id="poster-cover" viewBox="0 0 ${item.poster.width} ${item.poster.height}" preserveAspectRatio="xMidYMid slice">
      <use href="#poster-source"/>
    </symbol>
    <symbol id="poster-contain" viewBox="0 0 ${item.poster.width} ${item.poster.height}" preserveAspectRatio="xMidYMid meet">
      <use href="#poster-source"/>
    </symbol>
    <filter id="background-blur" x="-15%" y="-25%" width="130%" height="150%">
      <feGaussianBlur stdDeviation="42"/>
      <feColorMatrix type="saturate" values="0.9"/>
    </filter>
    <filter id="poster-shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="24" stdDeviation="24" flood-color="#000" flood-opacity="0.65"/>
    </filter>
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#050505" stop-opacity="0.32"/>
      <stop offset="0.44" stop-color="#050505" stop-opacity="0.62"/>
      <stop offset="1" stop-color="#050505" stop-opacity="0.92"/>
    </linearGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.5"/>
    </linearGradient>
    <clipPath id="poster-clip">
      <rect x="${posterX}" y="${posterY}" width="${posterWidth}" height="${posterHeight}" rx="18"/>
    </clipPath>
  </defs>

  <rect width="1600" height="900" fill="#111"/>
  <g filter="url(#background-blur)" transform="translate(-55 -55) scale(1.08)">
    <use href="#poster-cover" x="0" y="0" width="1600" height="900"/>
  </g>
  <rect width="1600" height="900" fill="url(#shade)"/>
  <rect width="1600" height="900" fill="url(#floor)"/>

  <g filter="url(#poster-shadow)">
    <rect x="${posterX - 7}" y="${posterY - 7}" width="${posterWidth + 14}" height="${posterHeight + 14}" rx="23" fill="#fff" fill-opacity="0.14"/>
    <g clip-path="url(#poster-clip)">
      <use href="#poster-contain" x="${posterX}" y="${posterY}" width="${posterWidth}" height="${posterHeight}"/>
    </g>
  </g>

  <g font-family="Arial, Helvetica, sans-serif" fill="#fff">
    <rect x="760" y="190" width="${item.label === "MOVIE" ? 258 : 302}" height="54" rx="27" fill="#f5c518"/>
    <text x="789" y="227" font-size="27" font-weight="800" letter-spacing="2" fill="#111">IMDb #1 ${escapeXml(item.label)}</text>
    <text x="760" y="284" font-size="22" font-weight="700" letter-spacing="5" fill="#fff" fill-opacity="0.72">CURRENT MOST POPULAR</text>
    <text font-size="${titleStyle.fontSize}" font-weight="800" letter-spacing="-2">${titleText}</text>
    <rect x="760" y="${titleStartY + titleLines.length * titleStyle.lineHeight + 20}" width="120" height="6" rx="3" fill="#f5c518"/>
    <text x="760" y="${titleStartY + titleLines.length * titleStyle.lineHeight + 82}" font-size="24" font-weight="500" fill="#fff" fill-opacity="0.68">Poster artwork from IMDb</text>
  </g>
</svg>`;

  const headers = new Headers();
  headers.set("Content-Type", "image/svg+xml; charset=utf-8");
  headers.set(
    "Content-Disposition",
    `inline; filename="${slugify(item.title)}-landscape-poster.svg"`,
  );
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  addItemHeaders(headers, item);
  headers.set("X-Image-Width", String(canvasWidth));
  headers.set("X-Image-Height", String(canvasHeight));
  headers.set("X-Poster-Source-Width", String(item.poster.width));
  headers.set("X-Poster-Source-Height", String(item.poster.height));

  return new Response(svg, { status: 200, headers });
}

function addItemHeaders(headers, item) {
  headers.set("X-IMDb-ID", item.id);
  headers.set("X-IMDb-Title", encodeURIComponent(item.title));
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
}

function isUsableImage(image) {
  return Boolean(
    image?.url &&
      Number.isFinite(image?.width) &&
      Number.isFinite(image?.height) &&
      image.width > 0 &&
      image.height > 0,
  );
}

function titleTypography(title) {
  const length = [...title].length;
  if (length <= 18) {
    return { fontSize: 92, lineHeight: 104, maxCharacters: 15 };
  }
  if (length <= 38) {
    return { fontSize: 76, lineHeight: 88, maxCharacters: 19 };
  }
  return { fontSize: 64, lineHeight: 76, maxCharacters: 23 };
}

function wrapTitle(value, maxCharacters, maxLines) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const originalWord of words) {
    let word = originalWord;

    while (word.length > maxCharacters) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(word.slice(0, maxCharacters - 1) + "-");
      word = word.slice(maxCharacters - 1);
      if (lines.length >= maxLines) break;
    }

    if (lines.length >= maxLines) break;

    const proposed = current ? `${current} ${word}` : word;
    if (proposed.length <= maxCharacters) {
      current = proposed;
    } else {
      if (current) lines.push(current);
      current = word;
    }

    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);

  const consumed = lines.join(" ").replace(/- /g, "").length;
  const originalLength = String(value).replace(/\s+/g, " ").trim().length;
  if (consumed < originalLength && lines.length) {
    const lastIndex = Math.min(lines.length, maxLines) - 1;
    lines[lastIndex] = `${lines[lastIndex].replace(/[. …]+$/u, "")}…`;
  }

  return lines.slice(0, maxLines);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function withPublicCacheHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set(
    "Cache-Control",
    `public, max-age=${BROWSER_CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
  );
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function toHeadResponse(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function imageExtension(contentType) {
  if (contentType.includes("avif")) return "avif";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("png")) return "png";
  return "jpg";
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80) || "imdb-number-one";
}
