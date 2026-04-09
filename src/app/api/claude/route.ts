import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Accepts Anthropic-style body: { model, messages, system, max_tokens }
// Translates to Groq (OpenAI-compatible) and returns { content: [{ text }] }
export async function POST(req: NextRequest) {
  const { messages, system, max_tokens } = await req.json();

  // Build OpenAI-compatible messages, prepending system prompt if present
  const openaiMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages.map((m: { role: string; content: string }) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const groqBody = {
    model: "llama-3.3-70b-versatile",
    messages: openaiMessages,
    max_tokens: max_tokens ?? 8096,
  };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(groqBody),
  });

  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json(
      { error: { message: data.error?.message ?? "Groq error" } },
      { status: res.status, headers: CORS_HEADERS }
    );
  }

  const text = data.choices?.[0]?.message?.content ?? "";

  // Return in Anthropic shape so the artifact needs no changes
  return NextResponse.json(
    { content: [{ text }] },
    { headers: CORS_HEADERS }
  );
}
