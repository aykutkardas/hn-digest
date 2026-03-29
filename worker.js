const LIST_CACHE_TTL = 15 * 60 * 1000;
let topStoryIdsCache = { time: 0, ids: [] };
const summaryCache = new Map();

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

async function handleStories(url) {
  try {
    const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
    const limit = 15;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    let topIds = topStoryIdsCache.ids;
    if (
      Date.now() - topStoryIdsCache.time > LIST_CACHE_TTL ||
      topIds.length === 0
    ) {
      const hnRes = await fetch(
        "https://hacker-news.firebaseio.com/v0/topstories.json"
      );
      topIds = await hnRes.json();
      topStoryIdsCache = { time: Date.now(), ids: topIds };
    }

    const pageIds = topIds.slice(startIndex, endIndex);
    const storyPromises = pageIds.map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) =>
        r.json()
      )
    );
    const stories = await Promise.all(storyPromises);

    return json({
      stories,
      hasMore: endIndex < topIds.length,
    });
  } catch {
    return json({ error: "Failed to fetch stories" }, 500);
  }
}

async function handleSummarize(request, url, env) {
  const storyId = url.searchParams.get("id");
  const lang = url.searchParams.get("lang") || "en";

  if (!storyId) {
    return json({ error: "Missing story ID" }, 400);
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
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        try {
          const pageRes = await fetch(story.url, {
            signal: controller.signal,
          });
          const html = await pageRes.text();

          const cleanText = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
            .replace(/<(?!img|iframe|\/iframe)[^>]+>/gi, " ")
            .replace(/\s+/g, " ")
            .substring(0, 15000);

          contentToSummarize = `Title: ${story.title}\nContent: ${cleanText}`;
        } finally {
          clearTimeout(t);
        }
      } catch {
        contentToSummarize = `Title: ${story.title}\n(Could not fetch page content, summarize based on title).`;
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
    summaryCache.set(cacheKey, summary);

    return json({ summary, cached: false });
  } catch (error) {
    console.error("Summary Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to generate summary.";
    return json({ error: message }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
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

    return env.ASSETS.fetch(request);
  },
};
