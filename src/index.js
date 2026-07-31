const GRAPHQL_ENDPOINTS = [
  "https://api.graphql.imdb.com/",
  "https://caching.graphql.imdb.com/",
];

const CACHE_SECONDS = 6 * 60 * 60;
const BROWSER_CACHE_SECONDS = 60 * 60;

const CHARTS = {
  "/movie": {
    chartType: "MOST_POPULAR_MOVIES",
    label: "movie",
  },
  "/tv": {
    chartType: "MOST_POPULAR_TV_SHOWS",
    label: "tv",
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
        service: "IMDb #1 portrait posters",
        endpoints: {
          moviePoster: "/movie",
          tvPoster: "/tv",
          movieMetadata: "/movie?json=1",
          tvMetadata: "/tv?json=1",
          moviePosterUrl: "/movie?url=1",
          tvPosterUrl: "/tv?url=1",
        },
        note: "The /movie and /tv routes return IMDb's vertical primary poster directly.",
      });
    }

    const chart = CHARTS[url.pathname];
    if (!chart) {
      return jsonResponse({ error: "Not found. Use /movie or /tv." }, 404);
    }

    const bypassCache = url.searchParams.get("refresh") === "1";
    const cache = caches.default;
    const cacheKey = createCacheKey(url);

    if (!bypassCache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return request.method === "HEAD" ? toHeadResponse(cached) : cached;
      }
    }

    try {
      const item = await getNumberOnePoster(chart);
      let response;

      if (url.searchParams.get("json") === "1") {
        response = jsonResponse({
          rank: item.rank,
          imdbId: item.id,
          title: item.title,
          category: item.category,
          poster: item.poster.url,
          posterWidth: item.poster.width,
          posterHeight: item.poster.height,
          imdbUrl: `https://www.imdb.com/title/${item.id}/`,
        });
      } else if (url.searchParams.get("url") === "1") {
        response = new Response(`${item.poster.url}\n`, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        response = await proxyPoster(item);
      }

      response = withPublicCacheHeaders(response);

      if (!bypassCache) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return request.method === "HEAD" ? toHeadResponse(response) : response;
    } catch (error) {
      console.error(error);
      return jsonResponse(
        {
          error: "Could not fetch the current IMDb portrait poster.",
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

  if (!isUsablePoster(poster)) {
    throw new Error(
      `IMDb returned no usable primary poster for ${title.titleText?.text ?? title.id}.`,
    );
  }

  return {
    rank: edge.currentRank ?? 1,
    id: title.id,
    title: title.titleText?.text ?? title.id,
    category: chart.label,
    poster: {
      ...poster,
      url: getLargestIMDbImageUrl(poster.url),
    },
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
          "User-Agent": "Mozilla/5.0 IMDbPortraitPosterWorker/1.3",
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

async function proxyPoster(item) {
  const response = await fetch(item.poster.url, {
    headers: {
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      Referer: `https://www.imdb.com/title/${item.id}/`,
      "User-Agent": "Mozilla/5.0 IMDbPortraitPosterWorker/1.3",
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

  const headers = new Headers();
  const contentType = response.headers.get("Content-Type") ?? "image/jpeg";
  const extension = imageExtension(contentType);

  headers.set("Content-Type", contentType);
  headers.set(
    "Content-Disposition",
    `inline; filename="${slugify(item.title)}-poster.${extension}"`,
  );
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-IMDb-ID", item.id);
  headers.set("X-IMDb-Rank", String(item.rank));
  headers.set("X-IMDb-Title", encodeURIComponent(item.title));
  headers.set("X-Poster-Orientation", "portrait");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(response.body, {
    status: 200,
    headers,
  });
}

function isUsablePoster(image) {
  return Boolean(
    image?.url &&
      Number.isFinite(image.width) &&
      Number.isFinite(image.height) &&
      image.width > 0 &&
      image.height > 0,
  );
}

function getLargestIMDbImageUrl(imageUrl) {
  try {
    const url = new URL(imageUrl);
    // Remove IMDb resize/crop instructions while preserving the standard _V1_ marker.
    url.pathname = url.pathname.replace(/\._V1_.*(?=\.[a-zA-Z0-9]+$)/, "._V1_");
    return url.toString();
  } catch {
    return imageUrl;
  }
}

function createCacheKey(url) {
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("refresh");
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function withPublicCacheHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set(
    "Cache-Control",
    `public, max-age=${BROWSER_CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
  );
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function toHeadResponse(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function imageExtension(contentType) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("avif")) return "avif";
  return "jpg";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "imdb-number-one";
}
