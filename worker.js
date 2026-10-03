const EMBED_CHECK_CACHE_TTL = 15 * 60 * 1000;
const EMBED_CHECK_CACHE_MAX = 600;

/** @type {Map<string, { t: number, result: { embeddable: boolean, reason: string | null } }>} */
const embedCheckCache = new Map();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

/** Merge duplicate Content-Security-Policy header values from the response. */
function combinedCspHeader(headers) {
  const parts = [];
  for (const [k, v] of headers) {
    if (k.toLowerCase() === "content-security-policy") parts.push(v);
  }
  return parts.length ? parts.join("; ") : headers.get("Content-Security-Policy") || "";
}

function extractFrameAncestors(cspValue) {
  if (!cspValue) return "";
  for (const piece of cspValue.split(";")) {
    const s = piece.trim();
    if (/^frame-ancestors\s/i.test(s)) {
      return s.replace(/^frame-ancestors\s+/i, "").trim();
    }
  }
  return "";
}

/**
 * Best-effort from response headers only. False negatives/positives are possible.
 * `parentOrigin` should be the embedding page origin (e.g. https://your-app.pages.dev).
 */
function embeddableFromHeaders(headers, parentOrigin) {
  const xfo = (headers.get("X-Frame-Options") || "").trim().toUpperCase();
  if (xfo === "DENY" || xfo === "SAMEORIGIN") {
    return { embeddable: false, reason: "x_frame_options" };
  }

  const csp = combinedCspHeader(headers);
  const faRaw = extractFrameAncestors(csp);
  if (!faRaw) {
    return { embeddable: true, reason: null };
  }

  if (/\b'none'\b/i.test(faRaw)) {
    return { embeddable: false, reason: "csp_frame_ancestors" };
  }
  if (/^\s*'self'\s*$/i.test(faRaw)) {
    return { embeddable: false, reason: "csp_frame_ancestors" };
  }

  let parent = "";
  try {
    if (parentOrigin) parent = new URL(parentOrigin).origin;
  } catch {
    parent = "";
  }

  if (parent) {
    const tokens = faRaw.match(/(?:'[^']*'|[^\s']+)/g) || [];
    let allowed = false;
    for (const raw of tokens) {
      const t = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
      if (t === "*") {
        allowed = true;
        break;
      }
      if (t.toLowerCase() === "self") continue;
      try {
        const u = new URL(t);
        if (u.origin === parent) {
          allowed = true;
          break;
        }
      } catch {
        /* ignore malformed token */
      }
    }
    if (!allowed) {
      return { embeddable: false, reason: "csp_frame_ancestors" };
    }
  }

  return { embeddable: true, reason: null };
}

/** True when `href` is the link of a story in that day's digest. */
async function isDigestStoryUrl(env, date, href) {
  if (!env.DIGEST || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const body = await env.DIGEST.get(`digest:${date}`);
  if (!body) return false;
  return (JSON.parse(body).stories || []).some((story) => {
    try {
      return story.url && new URL(story.url).href === href;
    } catch {
      return false;
    }
  });
}

async function handleEmbedCheck(url, env) {
  const target = url.searchParams.get("url");
  const parentOrigin = (url.searchParams.get("parent") || "").trim();
  if (!target || !isPublicHttpUrlForFetch(target)) {
    return json({ embeddable: false, error: "invalid_url" }, 400);
  }

  let canonical;
  try {
    canonical = new URL(target).href;
  } catch {
    return json({ embeddable: false, error: "invalid_url" }, 400);
  }

  // Only links from the digest are checked, so this can't be used to probe arbitrary URLs.
  if (!(await isDigestStoryUrl(env, url.searchParams.get("date") || "", canonical))) {
    return json({ embeddable: false, error: "unknown_url" }, 403);
  }

  const cacheKey = `${canonical}\0${parentOrigin}`;
  const hit = embedCheckCache.get(cacheKey);
  if (hit && Date.now() - hit.t < EMBED_CHECK_CACHE_TTL) {
    return json({ ...hit.result, cached: true });
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 7000);
  try {
    let res = await fetch(canonical, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(canonical, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { Range: "bytes=0-0" },
      });
    }
    const result = embeddableFromHeaders(res.headers, parentOrigin);
    try {
      if (res.body?.cancel) await res.body.cancel();
    } catch {
      /* ignore */
    }
    embedCheckCacheSet(cacheKey, { t: Date.now(), result });
    return json({ ...result, cached: false });
  } catch {
    return json({ embeddable: true, reason: "check_failed" });
  } finally {
    clearTimeout(t);
  }
}

/** Block obvious SSRF targets when fetching arbitrary story URLs. */
function isPublicHttpUrlForFetch(urlString) {
  try {
    const u = new URL(urlString);
    if (u.username || u.password) return false;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    ) {
      return false;
    }
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4.test(host)) {
      const p = host.split(".").map((x) => parseInt(x, 10));
      if (p.some((n) => n > 255)) return false;
      if (p[0] === 10) return false;
      if (p[0] === 127) return false;
      if (p[0] === 0) return false;
      if (p[0] === 192 && p[1] === 168) return false;
      if (p[0] === 169 && p[1] === 254) return false;
      if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function embedCheckCacheSet(key, entry) {
  if (embedCheckCache.size >= EMBED_CHECK_CACHE_MAX && !embedCheckCache.has(key)) {
    const first = embedCheckCache.keys().next().value;
    embedCheckCache.delete(first);
  }
  embedCheckCache.set(key, entry);
}

/**
 * Daily digest written to KV by scripts/daily-digest.mjs: `digest:latest`, `digest:<date>`,
 * and `digest:index` (the list of available dates, newest first).
 */
async function handleDigest(url, env, key) {
  if (!env.DIGEST) return json({ error: "Digest storage is not configured." }, 503);
  if (!key) {
    const date = url.searchParams.get("date") || "";
    key = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `digest:${date}` : "digest:latest";
  }
  const body = await env.DIGEST.get(key);
  if (!body) return json({ error: "No digest yet." }, 404);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=600",
      ...corsHeaders(),
    },
  });
}

/** App pages: /en, /tr, /<lang>/<date>, /<lang>/<date>/<slug>. All are served by index.html. */
const APP_ROUTE = /^\/(en|tr)(?:\/\d{4}-\d{2}-\d{2}(?:\/[a-z0-9-]+)?)?$/;

const DEFAULT_LANG = "en";

/**
 * "/" goes to the English digest. Links from before the path-based URLs
 * (?date=…&story=<id>) are permanently redirected to their new address.
 */
async function handleRoot(url, env) {
  const lang = DEFAULT_LANG;
  const date = url.searchParams.get("date") || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    let target = `/${lang}/${date}`;
    const storyId = Number(url.searchParams.get("story"));
    const body = storyId && env.DIGEST ? await env.DIGEST.get(`digest:${date}`) : null;
    const story = body ? (JSON.parse(body).stories || []).find((s) => s.id === storyId) : null;
    if (story?.slug) target += `/${story.slug}`;
    return Response.redirect(new URL(target, url), 301);
  }
  return new Response(null, { status: 302, headers: { Location: `/${lang}` } });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (path === "/") {
      return handleRoot(url, env);
    }
    if (APP_ROUTE.test(path)) {
      // Asking the asset server for "/" returns index.html without its own redirects.
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }

    if (path === "/api/digest") {
      return handleDigest(url, env);
    }
    if (path === "/api/digests") {
      return handleDigest(url, env, "digest:index");
    }
    if (path === "/api/embed-check") {
      return handleEmbedCheck(url, env);
    }

    return env.ASSETS.fetch(request);
  },
};
