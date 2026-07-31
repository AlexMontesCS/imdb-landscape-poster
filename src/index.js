const GRAPHQL_ENDPOINTS = [
  "https://api.graphql.imdb.com/",
  "https://caching.graphql.imdb.com/",
];

const CACHE_SECONDS = 6 * 60 * 60;
const BROWSER_CACHE_SECONDS = 60 * 60;

const CHARTS = {
  "/movie": "MOST_POPULAR_MOVIES",
  "/tv": "MOST_POPULAR_TV_SHOWS",
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
        service: "IMDb #1 landscape image",
        endpoints: {
          movie: "/movie",
          tv: "/tv",
          movieMetadata: "/movie?json=1",
          tvMetadata: "/tv?json=1",
        },
        note: "Uses IMDb's unofficial public website GraphQL endpoint; no API key is required, but IMDb may change it.",
      });
    }

    const chartType = CHARTS[url.pathname];
    if (!chartType) {
      return jsonResponse({ error: "Not found. Use /movie or /tv." }, 404);
    }

    // Cache /movie, /tv, and their query-string variants independently.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return request.method === "HEAD"
        ? new Response(null, cached)
        : cached;
    }

    try {
      const item = await getNumberOneLandscape(chartType);

      let response;
      if (url.searchParams.get("json") === "1") {
        response = jsonResponse({
          rank: item.rank,
          imdbId: item.id,
          title: item.title,
          image: item.image.url,
          width: item.image.width,
          height: item.image.height,
          imageType: item.image.type,
          imdbUrl: `https://www.imdb.com/title/${item.id}/`,
        });
      } else if (url.searchParams.get("url") === "1") {
        response = new Response(item.image.url + "\n", {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        response = await proxyImage(item);
      }

      response = withPublicCacheHeaders(response);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      return request.method === "HEAD"
        ? new Response(null, response)
        : response;
    } catch (error) {
      console.error(error);
      return jsonResponse(
        {
          error: "Could not fetch the current IMDb landscape image.",
          detail: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  },
};

async function getNumberOneLandscape(chartType) {
  const query = `
    query {
      chartTitles(first: 1, chart: { chartType: ${chartType} }) {
        edges {
          currentRank
          node {
            id
            titleText { text }
            primaryImage { url width height type }
            imageTypes {
              imageType { imageTypeId text }
              images {
                edges {
                  node { url width height type }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await fetchIMDbGraphQL(query);
  const edge = data?.chartTitles?.edges?.[0];
  const title = edge?.node;

  if (!title?.id) {
    throw new Error("IMDb returned no #1 chart title.");
  }

  const candidates = [];

  for (const group of title.imageTypes ?? []) {
    const groupType = group?.imageType?.imageTypeId ?? "unknown";
    for (const edge of group?.images?.edges ?? []) {
      const image = edge?.node;
      if (isUsableImage(image)) {
        candidates.push({ ...image, type: image.type ?? groupType });
      }
    }
  }

  // Keep this fallback, although IMDb's primary image is normally portrait.
  if (isUsableImage(title.primaryImage)) {
    candidates.push({ ...title.primaryImage, type: title.primaryImage.type ?? "primary" });
  }

  const landscape = candidates
    .filter((image) => image.width / image.height >= 1.2)
    .sort((a, b) => scoreImage(b) - scoreImage(a))[0];

  if (!landscape) {
    throw new Error(`No landscape image was returned for ${title.titleText?.text ?? title.id}.`);
  }

  return {
    rank: edge.currentRank ?? 1,
    id: title.id,
    title: title.titleText?.text ?? title.id,
    image: landscape,
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
          "User-Agent": "Mozilla/5.0 IMDbLandscapeWorker/1.0",
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

async function proxyImage(item) {
  const upstream = await fetch(item.image.url, {
    headers: {
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      Referer: `https://www.imdb.com/title/${item.id}/`,
      "User-Agent": "Mozilla/5.0 IMDbLandscapeWorker/1.0",
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

  if (!upstream.ok || !upstream.body) {
    throw new Error(`IMDb image server returned HTTP ${upstream.status}.`);
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("Content-Type") ?? "image/jpeg";
  const extension = imageExtension(contentType);
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", `inline; filename="${slugify(item.title)}-landscape.${extension}"`);
  headers.set("X-IMDb-ID", item.id);
  headers.set("X-IMDb-Title", encodeURIComponent(item.title));
  headers.set("X-Image-Width", String(item.image.width));
  headers.set("X-Image-Height", String(item.image.height));
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, { status: 200, headers });
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

function scoreImage(image) {
  const ratio = image.width / image.height;
  const ratioScore = 1 / (1 + Math.abs(ratio - 16 / 9));
  const areaScore = Math.log10(Math.max(1, image.width * image.height));

  const type = String(image.type ?? "").toLowerCase();
  let typeScore = 0;
  if (type.includes("still")) typeScore += 6;
  if (type.includes("publicity")) typeScore += 3;
  if (type.includes("production")) typeScore += 2;
  if (type.includes("behind")) typeScore += 1;
  if (type.includes("poster")) typeScore -= 2;
  if (type.includes("event")) typeScore -= 4;

  return typeScore + ratioScore * 5 + areaScore;
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
