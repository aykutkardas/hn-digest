# hn-digest

A small web app that lists [Hacker News](https://news.ycombinator.com/) top stories and generates AI summaries (with optional translation) using the OpenAI API. The backend is Express; the UI is static files under `public/`.

![hn-digest preview](preview.png)

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (uses built-in `fetch`)
- An [OpenAI API key](https://platform.openai.com/) for `/api/summarize`

## Setup

1. Clone the repository and install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file in the project root:

   ```bash
   OPENAI_API_KEY=sk-...
   ```

   Optional: set `PORT` (defaults to `3000`).

3. Start the server:

   ```bash
   node server.js
   ```

4. Open [http://localhost:3000](http://localhost:3000) (or your `PORT`) in a browser.

To avoid Node’s “module type not specified” warning, you can add `"type": "module"` to `package.json`.

## API

- `GET /api/stories?page=1` — Paginated top stories from the HN Firebase API (cached ~15 minutes).
- `GET /api/summarize?id=<storyId>&lang=<iso>` — Generates a cached summary for a story; `lang` defaults to `en`.

## Licence

This project is licensed under the MIT License — see [LICENCE.md](LICENCE.md).
