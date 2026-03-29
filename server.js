import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, "public")));

let topStoryIdsCache = { time: 0, ids: [] };
const summaryCache = new Map();
const LIST_CACHE_TTL = 15 * 60 * 1000;

app.get("/api/stories", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
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

    res.json({ stories, hasMore: endIndex < topIds.length });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch stories" });
  }
});

app.get("/api/summarize", async (req, res) => {
  const storyId = req.query.id;
  const lang = req.query.lang || "en";
  if (!storyId) return res.status(400).json({ error: "Missing story ID" });

  const cacheKey = `${storyId}_${lang}`;

  if (summaryCache.has(cacheKey)) {
    return res.json({ summary: summaryCache.get(cacheKey), cached: true });
  }

  const authHeader = req.get("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(\S+)/i);
  const apiKey = (bearerMatch?.[1] || "").trim() || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(401).json({
      error:
        "Missing OpenAI API key. Add your key in settings or set OPENAI_API_KEY on the server.",
    });
  }

  try {
    const storyRes = await fetch(
      `https://hacker-news.firebaseio.com/v0/item/${storyId}.json`
    );
    const story = await storyRes.json();

    let contentToSummarize = story.title;

    if (story.url) {
      try {
        const pageRes = await fetch(story.url, {
          signal: AbortSignal.timeout(5000),
        });
        const html = await pageRes.text();

        // UPDATED REGEX: Strips scripts/styles, and all tags EXCEPT <img> and <iframe>
        const cleanText = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<(?!img|iframe|\/iframe)[^>]+>/gi, " ")
          .replace(/\s+/g, " ")
          .substring(0, 15000);

        contentToSummarize = `Title: ${story.title}\nContent: ${cleanText}`;
      } catch (e) {
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
    if (aiData.error) throw new Error(aiData.error.message);

    const summary = aiData.choices[0].message.content;

    summaryCache.set(cacheKey, summary);
    res.json({ summary, cached: false });
  } catch (error) {
    console.error("Summary Error:", error);
    res.status(500).json({ error: "Failed to generate summary." });
  }
});

app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
