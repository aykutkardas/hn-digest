#!/usr/bin/env node
/**
 * Daily HN digest: fetches today's top 10 stories, summarizes each one in English and
 * Turkish with a single gpt-4o-mini call, writes digests/<date>.{json,md} locally and
 * uploads the JSON to the DIGEST KV namespace used by /api/digest.
 *
 * Usage:
 *   node scripts/daily-digest.mjs                  today's front page (scheduled run)
 *   node scripts/daily-digest.mjs --date 2026-09-30 best stories posted on a past day
 *   node scripts/daily-digest.mjs --backfill 10     the 10 days before today, skipping existing ones
 *   node scripts/daily-digest.mjs --reslug          add slugs to existing digests and re-upload them
 *   add --no-upload to skip publishing to KV
 * Requires OPENAI_API_KEY in .env (or the environment) and a logged-in Wrangler for upload.
 */
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIGEST_DIR = join(ROOT, "digests");
const SUMMARY_CACHE_DIR = join(DIGEST_DIR, "summaries");
const TOP_COUNT = 10;
const MODEL = "gpt-4o-mini";
const PAGE_FETCH_TIMEOUT_MS = 10000;
const OPENAI_TIMEOUT_MS = 60000;
const MAX_SOURCE_CHARS = 12000;
const UPLOAD = !process.argv.includes("--no-upload");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/** Local calendar date (YYYY-MM-DD), so the digest matches the day it ran. */
function localDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("sv-SE");
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function topStories() {
  const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json");
  const stories = [];
  for (const id of ids) {
    if (stories.length >= TOP_COUNT) break;
    const item = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    if (item && !item.dead && !item.deleted && item.type === "story") stories.push(item);
  }
  return stories;
}

/**
 * The HN API only exposes the current front page, so past days come from HN's Algolia
 * search: the highest-scoring stories posted that (local) day.
 */
async function bestStoriesOn(date) {
  const [y, m, d] = date.split("-").map(Number);
  const start = Math.floor(new Date(y, m - 1, d).getTime() / 1000);
  const end = Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000);
  const { hits } = await fetchJson(
    `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=50&numericFilters=created_at_i>=${start},created_at_i<${end}`
  );
  return hits
    .filter((h) => h.title)
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, TOP_COUNT)
    .map((h) => ({
      id: Number(h.objectID),
      title: h.title,
      url: h.url || null,
      by: h.author,
      score: h.points || 0,
      descendants: h.num_comments || 0,
      time: h.created_at_i,
      text: h.story_text || null,
    }));
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SOURCE_CHARS);
}

function isPrivateAddress(address) {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/** Story links are fetched from this machine, so never follow one into the local network. */
async function isPublicUrl(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addresses.length > 0 && !addresses.some((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

async function sourceText(story) {
  if (story.text) return htmlToText(story.text);
  if (!story.url) return "";
  const signal = AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS);
  try {
    // Follow redirects by hand so every hop gets the same public-address check.
    let url = story.url;
    for (let hop = 0; hop < 5; hop++) {
      if (!(await isPublicUrl(url))) return "";
      const res = await fetch(url, {
        signal,
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (hn-digest daily)" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).href;
        continue;
      }
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !/text|html|xml|json/i.test(type)) return "";
      return htmlToText(await res.text());
    }
    return "";
  } catch {
    return "";
  }
}

const SYSTEM_PROMPT = `You summarize Hacker News stories for a technical reader.
Return JSON with two fields, "en" (English) and "tr" (Turkish). Both contain the same summary as Markdown:
- One bold sentence saying what this is.
- 3-5 bullets with the concrete details (names, numbers, versions, claims, tradeoffs).
- One line starting with "**Why it matters:**" (Turkish: "**Neden önemli:**").
Keep each language under ~180 words. If only the title is available, say so and avoid inventing details.
Write natural Turkish, not a literal translation; keep technical terms in English where Turkish developers would.`;

async function summarize(story, text) {
  const content = text
    ? `Title: ${story.title}\nURL: ${story.url || "(HN post)"}\nContent: ${text}`
    : `Title: ${story.title}\nURL: ${story.url || "(HN post)"}\n(Page content unavailable; summarize from the title only.)`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 1200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "bilingual_summary",
          strict: true,
          schema: {
            type: "object",
            properties: { en: { type: "string" }, tr: { type: "string" } },
            required: ["en", "tr"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
  const parsed = JSON.parse(data.choices[0].message.content);
  return { summaries: { en: parsed.en, tr: parsed.tr }, usage: data.usage };
}

/** URL slug from a story title, e.g. "Zig v0.17.0" -> "zig-v0-17-0". */
function slugify(title, fallback) {
  const slug = String(title)
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return String(fallback);
  if (slug.length <= 80) return slug;
  const cut = slug.slice(0, 80);
  return cut.slice(0, cut.lastIndexOf("-") > 40 ? cut.lastIndexOf("-") : 80);
}

/** Gives every entry a slug that is unique within its day (dupes get -2, -3, ...). */
function withSlugs(entries) {
  const used = new Set();
  return entries.map((entry) => {
    const base = slugify(entry.title, entry.id);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return { ...entry, slug };
  });
}

/** Keeps the closing "Why it matters" line out of the preceding Markdown list. */
function tidy(markdown) {
  return markdown.replace(/\n+(\*\*(?:Why it matters|Neden önemli):\*\*)/g, "\n\n$1").trim();
}

/** Summaries are cached per story so a story that stays on the front page isn't paid for twice. */
async function summariesFor(story) {
  const cacheFile = join(SUMMARY_CACHE_DIR, `${story.id}.json`);
  if (existsSync(cacheFile)) return { summaries: JSON.parse(readFileSync(cacheFile, "utf8")), cached: true };
  const { summaries, usage } = await summarize(story, await sourceText(story));
  writeFileSync(cacheFile, JSON.stringify(summaries, null, 2));
  return { summaries, cached: false, usage };
}

function toMarkdown(digest) {
  const lines = [`# Hacker News Top ${digest.stories.length} · ${digest.date}`, ""];
  digest.stories.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s.title}`, "");
    lines.push(`${s.score} pts · ${s.descendants || 0} comments · [HN](https://news.ycombinator.com/item?id=${s.id})${s.url ? ` · [Source](${s.url})` : ""}`, "");
    lines.push("### English", "", s.summaries.en, "", "### Türkçe", "", s.summaries.tr, "", "---", "");
  });
  return lines.join("\n");
}

function uploadToKv(key, file) {
  const wrangler = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  execFileSync(process.execPath, [wrangler, "kv", "key", "put", key, "--path", file, "--binding", "DIGEST", "--remote"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Dates that have a local digest file, newest first; published as digest:index. */
function writeIndex() {
  const dates = readdirSync(DIGEST_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
    .reverse();
  const file = join(DIGEST_DIR, "index.json");
  writeFileSync(file, JSON.stringify(dates));
  return file;
}

async function buildDigest(date, stories, { latest }) {
  log(`Building digest for ${date}`);
  let generated = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const entries = [];
  for (const story of stories) {
    try {
      const { summaries, cached, usage } = await summariesFor(story);
      if (!cached) {
        generated++;
        promptTokens += usage?.prompt_tokens || 0;
        completionTokens += usage?.completion_tokens || 0;
      }
      entries.push({
        id: story.id,
        title: story.title,
        url: story.url || null,
        by: story.by,
        score: story.score,
        descendants: story.descendants || 0,
        time: story.time,
        summaries: { en: tidy(summaries.en), tr: tidy(summaries.tr) },
      });
      log(`${cached ? "cached   " : "generated"} ${story.id} ${story.title}`);
    } catch (error) {
      log(`FAILED    ${story.id} ${story.title}: ${error.message}`);
    }
  }
  if (entries.length === 0) throw new Error(`No stories were summarized for ${date}.`);

  const digest = { date, generatedAt: new Date().toISOString(), model: MODEL, stories: withSlugs(entries) };
  const jsonFile = join(DIGEST_DIR, `${date}.json`);
  writeFileSync(jsonFile, JSON.stringify(digest));
  writeFileSync(join(DIGEST_DIR, `${date}.md`), toMarkdown(digest));

  // gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output tokens.
  const cost = (promptTokens * 0.15 + completionTokens * 0.6) / 1e6;
  log(`${entries.length} stories, ${generated} new summaries, ${promptTokens}+${completionTokens} tokens, ~$${cost.toFixed(4)}`);

  if (UPLOAD) {
    uploadToKv(`digest:${date}`, jsonFile);
    if (latest) uploadToKv("digest:latest", jsonFile);
    log(`Uploaded digest:${date}${latest ? " and digest:latest" : ""}`);
  }
  return cost;
}

async function main() {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing. Add it to .env (see .env.example).");
  mkdirSync(SUMMARY_CACHE_DIR, { recursive: true });

  if (process.argv.includes("--reslug")) {
    const dates = JSON.parse(readFileSync(writeIndex(), "utf8"));
    for (const day of dates) {
      const file = join(DIGEST_DIR, `${day}.json`);
      const digest = JSON.parse(readFileSync(file, "utf8"));
      digest.stories = withSlugs(digest.stories);
      writeFileSync(file, JSON.stringify(digest));
      if (UPLOAD) uploadToKv(`digest:${day}`, file);
      log(`Slugged ${day}`);
    }
    if (UPLOAD && dates[0]) uploadToKv("digest:latest", join(DIGEST_DIR, `${dates[0]}.json`));
    return;
  }

  const backfill = Number(argValue("--backfill") || 0);
  const date = argValue("--date");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD.");

  if (backfill > 0) {
    let total = 0;
    for (let i = 1; i <= backfill; i++) {
      const day = localDate(i);
      if (existsSync(join(DIGEST_DIR, `${day}.json`))) {
        log(`Skipping ${day}, digest already exists`);
        continue;
      }
      total += await buildDigest(day, await bestStoriesOn(day), { latest: false });
    }
    log(`Backfill done, ~$${total.toFixed(4)} total`);
  } else if (date && date !== localDate()) {
    await buildDigest(date, await bestStoriesOn(date), { latest: false });
  } else {
    await buildDigest(localDate(), await topStories(), { latest: true });
  }

  const indexFile = writeIndex();
  if (UPLOAD) {
    uploadToKv("digest:index", indexFile);
    log("Uploaded digest:index");
  }
}

main().catch((error) => {
  log(`ERROR ${error.message}`);
  process.exitCode = 1;
});
