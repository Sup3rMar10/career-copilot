"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Citation, StreamEvent } from "./api/coach/route";

type ChatMessage = { role: "user" | "assistant"; content: string; citations?: Citation[] };

const ANALYZE_PROMPT =
  "Analyze how well my resume fits this job, using the sections described in your instructions.";
const MAX_PDF_BYTES = 8 * 1024 * 1024;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Citation markers like " [2]" are display-only; don't echo them back to the model.
const stripMarkers = (text: string) => text.replace(/ \[\d+\]/g, "");

function describe(c: Citation) {
  if (!c.pages) return c.doc;
  const [from, to] = c.pages;
  return from === to ? `${c.doc}, p.${from}` : `${c.doc}, pp.${from}-${to}`;
}

export default function Home() {
  const [resumeText, setResumeText] = useState("");
  const [pdf, setPdf] = useState<{ name: string; base64: string } | null>(null);
  const [jobDescription, setJobDescription] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const ready = (resumeText.trim() || pdf) && jobDescription.trim();

  async function onPickFile(file: File | undefined) {
    setFileError("");
    if (!file) return;
    if (file.type !== "application/pdf") {
      setFileError("Please choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setFileError("PDF is larger than 8 MB.");
      return;
    }
    setPdf({ name: file.name, base64: await readAsBase64(file) });
  }

  async function send(userText: string) {
    if (loading || !ready) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: userText }];
    setMessages([...history, { role: "assistant", content: "", citations: [] }]);
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resumeText: pdf ? undefined : resumeText,
          resumePdf: pdf ? { base64: pdf.base64, name: pdf.name } : undefined,
          jobDescription,
          messages: history.map((m) => ({ role: m.role, content: stripMarkers(m.content) })),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const { error } = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(error);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      const citations: Citation[] = [];

      const handle = (event: StreamEvent) => {
        if (event.t === "text") {
          text += event.v;
        } else {
          const { cite } = event;
          let n = citations.findIndex((c) => c.doc === cite.doc && c.quote === cite.quote);
          if (n === -1) n = citations.push(cite) - 1;
          text += ` [${n + 1}]`;
        }
        setMessages([...history, { role: "assistant", content: text, citations: [...citations] }]);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) handle(JSON.parse(line));
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages([
          ...history,
          { role: "assistant", content: `**Error:** ${(err as Error).message}` },
        ]);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <header>
        <h1 className="text-3xl font-semibold">Career Copilot</h1>
        <p className="mt-1 text-zinc-500">
          Upload your resume and paste a job posting. Claude scores your fit, rewrites your
          bullets, preps you for the interview, and cites the exact lines it relied on.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 text-sm font-medium">
          Your resume
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-zinc-400 p-3 font-normal">
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                onPickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <span>{pdf ? `📄 ${pdf.name}` : "Upload a PDF resume…"}</span>
            {pdf && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setPdf(null);
                }}
                className="ml-auto text-xs underline"
              >
                Remove
              </button>
            )}
          </label>
          {fileError && <p className="text-xs text-red-600">{fileError}</p>}
          {!pdf && (
            <textarea
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              rows={10}
              placeholder="…or paste resume text"
              className="rounded-md border border-zinc-300 bg-transparent p-3 font-normal dark:border-zinc-700"
            />
          )}
        </div>
        <label className="flex flex-col gap-2 text-sm font-medium">
          Job description
          <textarea
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            rows={12}
            placeholder="Paste the job posting…"
            className="rounded-md border border-zinc-300 bg-transparent p-3 font-normal dark:border-zinc-700"
          />
        </label>
      </section>

      <div className="flex gap-3">
        <button
          onClick={() => send(ANALYZE_PROMPT)}
          disabled={!ready || loading || messages.length > 0}
          className="rounded-md bg-black px-4 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          Analyze my fit
        </button>
        {messages.length > 0 && (
          <button onClick={reset} className="rounded-md border px-4 py-2">
            Start over
          </button>
        )}
      </div>

      <section className="flex flex-col gap-4">
        {/* messages[0] is the canned analyze prompt, so it isn't shown */}
        {messages.slice(1).map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="self-end rounded-lg bg-zinc-200 px-4 py-2 dark:bg-zinc-800">
              {m.content}
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-3">
              <div className="prose prose-zinc max-w-none dark:prose-invert">
                <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
              </div>
              {m.citations && m.citations.length > 0 && (
                <details className="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
                  <summary className="cursor-pointer font-medium">
                    Sources ({m.citations.length})
                  </summary>
                  <ol className="mt-2 flex flex-col gap-2">
                    {m.citations.map((c, n) => (
                      <li key={n}>
                        <span className="font-medium">
                          [{n + 1}] {describe(c)}
                        </span>
                        <blockquote className="mt-1 border-l-2 border-zinc-400 pl-3 text-zinc-500">
                          {c.quote}
                        </blockquote>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          ),
        )}
      </section>

      {messages.length > 1 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = input.trim();
            if (!text) return;
            setInput("");
            send(text);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a follow-up, e.g. “Mock-interview me on the first gap”"
            className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-black px-4 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            Send
          </button>
        </form>
      )}
    </main>
  );
}
