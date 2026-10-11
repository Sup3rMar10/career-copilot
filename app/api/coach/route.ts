import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

const client = new Anthropic();

const MODEL = "claude-opus-5-5";

// Base64 inflates by ~4/3, so this caps the PDF at roughly 8 MB.
const MAX_PDF_BASE64_CHARS = 11_000_000;

const COACH_INSTRUCTIONS = `You are a pragmatic career coach and technical recruiter.
You are given the user's resume and a target job description as documents. Ground every claim in those two documents:
cite the specific resume lines and job requirements you rely on, and never invent experience the resume does not show.
When asked to analyze fit, respond in Markdown with these sections:
## Match summary (a score out of 10 and two sentences of reasoning)
## Strengths to emphasize
## Gaps and how to address them
## Rewritten resume bullets (3-5, truthful, quantified only where the resume supports it)
## Likely interview questions (with a short talking point for each)
For follow-up questions, answer directly and concisely.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

type RequestBody = {
  resumeText?: string;
  resumePdf?: { base64: string; name?: string };
  jobDescription?: string;
  messages?: ChatMessage[];
};

// One NDJSON line per event; the browser parses them as they arrive.
export type StreamEvent =
  | { t: "text"; v: string }
  | { t: "cite"; cite: Citation };

export type Citation = {
  doc: string;
  quote: string;
  pages?: [number, number];
};

function toCitation(c: Anthropic.Beta.BetaCitationsDelta["citation"]): Citation | null {
  if (c.type === "page_location") {
    return {
      doc: c.document_title ?? "Document",
      quote: c.cited_text,
      pages: [c.start_page_number, c.end_page_number],
    };
  }
  if (c.type === "char_location") {
    return { doc: c.document_title ?? "Document", quote: c.cited_text };
  }
  return null;
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { resumeText, resumePdf, jobDescription, messages } = body;
  if ((!resumeText?.trim() && !resumePdf?.base64) || !jobDescription?.trim() || !messages?.length) {
    return Response.json(
      { error: "a resume (text or PDF), jobDescription and messages are required" },
      { status: 400 },
    );
  }
  if (resumePdf && resumePdf.base64.length > MAX_PDF_BASE64_CHARS) {
    return Response.json({ error: "PDF is too large (limit about 8 MB)" }, { status: 413 });
  }

  const resumeDoc: Anthropic.Beta.BetaRequestDocumentBlock = resumePdf
    ? {
        type: "document",
        title: "Resume",
        citations: { enabled: true },
        source: { type: "base64", media_type: "application/pdf", data: resumePdf.base64 },
      }
    : {
        type: "document",
        title: "Resume",
        citations: { enabled: true },
        source: { type: "text", media_type: "text/plain", data: resumeText!.trim() },
      };

  // Documents live in the first user turn with a cache breakpoint on the last one,
  // so follow-up turns re-read them from the prompt cache. Citations must be enabled
  // on every document or none.
  const jobDoc: Anthropic.Beta.BetaRequestDocumentBlock = {
    type: "document",
    title: "Job description",
    citations: { enabled: true },
    source: { type: "text", media_type: "text/plain", data: jobDescription.trim() },
    cache_control: { type: "ephemeral" },
  };

  const [first, ...rest] = messages;
  const apiMessages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: first.role,
      content: [resumeDoc, jobDoc, { type: "text", text: first.content }],
    },
    ...rest,
  ];

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: COACH_INSTRUCTIONS,
    messages: apiMessages,
  });

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, event: StreamEvent) =>
    controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type !== "content_block_delta") continue;
          if (event.delta.type === "text_delta") {
            send(controller, { t: "text", v: event.delta.text });
          } else if (event.delta.type === "citations_delta") {
            const cite = toCitation(event.delta.citation);
            if (cite) send(controller, { t: "cite", cite });
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          send(controller, { t: "text", v: "\n\n_The model declined to answer this request._" });
        } else if (final.stop_reason === "max_tokens") {
          send(controller, { t: "text", v: "\n\n_(Response was cut off.)_" });
        }
      } catch (error) {
        const message =
          error instanceof Anthropic.RateLimitError
            ? "Rate limited - try again shortly."
            : error instanceof Anthropic.AuthenticationError
              ? "Invalid or missing ANTHROPIC_API_KEY."
              : error instanceof Anthropic.BadRequestError
                ? `Request rejected: ${error.message}`
                : error instanceof Anthropic.APIError
                  ? `API error ${error.status}: ${error.message}`
                  : "Unexpected error.";
        send(controller, { t: "text", v: `\n\n**Error:** ${message}` });
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
