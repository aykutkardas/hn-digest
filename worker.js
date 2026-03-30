const LIST_CACHE_TTL = 15 * 60 * 1000;
const SUMMARY_CACHE_MAX = 400;
const EMBED_CHECK_CACHE_MAX = 600;
const PAGE_FETCH_TIMEOUT_MS = 8000;

const listIdCaches = {
  top: { time: 0, ids: [] },
  new: { time: 0, ids: [] },
};
const summaryCache = new Map();
/** @type {Map<string, { t: number, result: { embeddable: boolean, reason: string | null } }>} */
const embedCheckCache = new Map();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-OpenAI-Key",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function openAiKeyFromRequest(request) {
  const authHeader = (request.headers.get("authorization") || "").trim();
  let m = authHeader.match(/^Bearer\s+([\s\S]+)$/i);
  let token = (m?.[1] || "").trim();
  while (/^bearer\s+/i.test(token)) {
    token = token.replace(/^bearer\s+/i, "").trim();
  }
  if (token) return token;
  return (request.headers.get("x-openai-key") || "").trim();
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

async function handleEmbedCheck(url) {
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

  const cacheKey = `${canonical}\0${parentOrigin}`;
  const hit = embedCheckCache.get(cacheKey);
  if (hit && Date.now() - hit.t < LIST_CACHE_TTL) {
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

function summaryCacheSet(key, value) {
  if (summaryCache.size >= SUMMARY_CACHE_MAX && !summaryCache.has(key)) {
    const first = summaryCache.keys().next().value;
    summaryCache.delete(first);
  }
  summaryCache.set(key, value);
}

function embedCheckCacheSet(key, entry) {
  if (embedCheckCache.size >= EMBED_CHECK_CACHE_MAX && !embedCheckCache.has(key)) {
    const first = embedCheckCache.keys().next().value;
    embedCheckCache.delete(first);
  }
  embedCheckCache.set(key, entry);
}

async function handleStories(url) {
  try {
    const feed = url.searchParams.get("feed") === "new" ? "new" : "top";
    const hnListUrl =
      feed === "new"
        ? "https://hacker-news.firebaseio.com/v0/newstories.json"
        : "https://hacker-news.firebaseio.com/v0/topstories.json";

    const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
    const limit = 15;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    let cache = listIdCaches[feed];
    let topIds = cache.ids;
    if (
      Date.now() - cache.time > LIST_CACHE_TTL ||
      topIds.length === 0
    ) {
      const hnRes = await fetch(hnListUrl);
      topIds = await hnRes.json();
      if (!Array.isArray(topIds)) {
        throw new Error("Invalid HN list response");
      }
      cache = { time: Date.now(), ids: topIds };
      listIdCaches[feed] = cache;
    }

    const pageIds = topIds.slice(startIndex, endIndex);
    const storyPromises = pageIds.map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(
        (r) => r.json()
      )
    );
    const stories = await Promise.all(storyPromises);

    return json({
      stories,
      hasMore: endIndex < topIds.length,
      feed,
    });
  } catch {
    return json({ error: "Failed to fetch stories" }, 500);
  }
}

async function handleSummarize(request, url, env) {
  const storyId = url.searchParams.get("id");
  const lang = (url.searchParams.get("lang") || "en").slice(0, 12);

  if (!storyId || !/^\d+$/.test(storyId)) {
    return json({ error: "Missing or invalid story ID" }, 400);
  }

  const cacheKey = `${storyId}_${lang}`;
  if (summaryCache.has(cacheKey)) {
    return json({
      summary: summaryCache.get(cacheKey),
      cached: true,
    });
  }

  const apiKey =
    openAiKeyFromRequest(request) || (env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return json(
      {
        error:
          "Missing OpenAI API key. Add your key in settings or set OPENAI_API_KEY as a Worker secret.",
      },
      401
    );
  }

  try {
    const storyRes = await fetch(
      `https://hacker-news.firebaseio.com/v0/item/${storyId}.json`
    );
    const story = await storyRes.json();

    let contentToSummarize = story.title;

    if (story.url) {
      if (isPublicHttpUrlForFetch(story.url)) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
        try {
          const pageRes = await fetch(story.url, {
            signal: controller.signal,
            redirect: "follow",
          });
          const html = await pageRes.text();

          const cleanText = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
            .replace(/<(?!img|iframe|\/iframe)[^>]+>/gi, " ")
            .replace(/\s+/g, " ")
            .substring(0, 15000);

          contentToSummarize = `Title: ${story.title}\nContent: ${cleanText}`;
        } catch {
          contentToSummarize = `Title: ${story.title}\n(Could not fetch page content, summarize based on title).`;
        } finally {
          clearTimeout(t);
        }
      } else {
        contentToSummarize = `Title: ${story.title}\n(URL not fetched for security; summarize from title and context).`;
      }
    } else if (story.text) {
      contentToSummarize = `Title: ${story.title}\nContent: ${story.text}`;
    }

    const systemPrompt = `You are an expert technical summarizer writing for readers who want depth, not a headline recap.

Output requirements:
- Write in the language for ISO code '${lang}' for the entire answer (headings, bullets, and prose).
- Aim for substantial coverage when the source allows: multiple sections, rich bullets, and concrete detail (names, numbers, versions, claims, methodology) pulled from the text—not vague restatements.
- Use clear Markdown: **bold** for emphasis, bullet lists where helpful, short subheadings (##) to organize longer answers.
- If the source is long or dense, target roughly 500–900 words of useful synthesis unless the material is genuinely thin; never compress into a single short paragraph when more detail is justified.
- If the source is only a title or very sparse, say what is unknown, give careful educated context, and clearly label speculation.
- When the source includes important <img> or <iframe> tags (e.g. charts, embeds), preserve those tags in your summary so they still render.`;

    const userPrompt = `Summarize the following for a technical audience. Be thorough: explain what happens, why it matters, and any notable details or tradeoffs mentioned.\n\n${contentToSummarize}`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.45,
        max_tokens: 4096,
      }),
    });

    const aiData = await aiRes.json();
    if (aiData.error) {
      throw new Error(aiData.error.message || "OpenAI error");
    }

    const summary = aiData.choices[0].message.content;
    summaryCacheSet(cacheKey, summary);

    return json({ summary, cached: false });
  } catch (error) {
    console.error("summarize:", error);
    const message =
      error instanceof Error ? error.message : "Failed to generate summary.";
    return json({ error: message }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (path === "/api/stories") {
      return handleStories(url);
    }
    if (path === "/api/summarize") {
      return handleSummarize(request, url, env);
    }
    if (path === "/api/embed-check") {
      return handleEmbedCheck(url);
    }

    return env.ASSETS.fetch(request);
  },
};
