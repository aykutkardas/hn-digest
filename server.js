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

    // UPDATED PROMPT: Encourage keeping the media
    const systemPrompt = `You are an expert technical summarizer. Provide a detailed, insightful summary of the text using formatting (bullet points, bold text). 
        CRITICAL INSTRUCTION 1: You MUST translate and write your entire response in the language corresponding to the ISO code '${lang}'. 
        CRITICAL INSTRUCTION 2: If the source text contains important <img> or <iframe> tags (like YouTube videos or relevant charts), you SHOULD include them in your summary so the user can see them.`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: contentToSummarize },
        ],
        temperature: 0.5,
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
