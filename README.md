# Career Copilot

A Next.js app that uses Claude to compare your resume against a job posting. It scores your fit, rewrites your bullets, and preps you for the interview. You can then chat with follow-up questions such as "mock-interview me on the first gap".

## What it demonstrates

- **PDF input with citations**: the resume goes to Claude as a base64 `document` block (or plain text) with `citations: { enabled: true }`. Cited claims show `[n]` markers and a Sources panel with the page number and quoted text.
- **Streaming**: `client.beta.messages.stream` piped to the browser as NDJSON events (`text` and `cite`) through a `ReadableStream`.
- **Prompt caching**: the documents sit at the start of the first user turn with a `cache_control` breakpoint, so follow-up turns read them from the cache.
- **Adaptive thinking** with an explicit `effort` setting (`claude-opus-5-5`).
- **Refusal fallbacks** via the server-side `fallbacks: "default"` parameter.
- **Typed error handling** with the SDK's exception classes.

## Run it

```bash
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

## Layout

- `app/api/coach/route.ts`: streaming Claude endpoint
- `app/page.tsx`: UI (inputs, analysis, follow-up chat)

## Ideas to extend it

- Use the Files API to upload the PDF once instead of resending it each turn
- Save analyses per job and track applications
- Add an eval set to measure the quality of the rewritten bullets
