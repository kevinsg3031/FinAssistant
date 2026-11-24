// lib/google.js — minimal wrapper around the Google AI Studio Gemini API.
// No SDK dependency: plain fetch, so the whole project stays npm-install-free.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

class GoogleAIError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code; // "auth" | "rate_limited" | "other"
    this.status = status;
  }
}

function classifyStatus(status) {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  return "other";
}

async function readResponse(res, action) {
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new GoogleAIError(`Google AI returned a non-JSON response (HTTP ${res.status}).`, "other", res.status);
  }
  if (!res.ok) {
    throw new GoogleAIError(json.error?.message || `Google AI ${action} API error.`, classifyStatus(res.status), res.status);
  }
  return json;
}

/** Calls Gemini and returns parsed JSON, requested through generationConfig. */
async function chatJSON({ apiKey, model, messages, maxTokens = 3000 }) {
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  // Gemini requires at least one content part. The first interview turn starts
  // with instructions only, so provide a minimal user turn to initiate it.
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Begin the interview." }] });

  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json" },
    }),
  });
  const json = await readResponse(res, "generateContent");
  const text = (json.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new GoogleAIError("The model did not return valid JSON.", "other", 502);
  }
}

/** Calls Gemini batchEmbedContents and returns an array of number[] vectors. */
async function embed({ apiKey, model = "gemini-embedding-001", input }) {
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      requests: input.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      })),
    }),
  });
  const json = await readResponse(res, "embedding");
  return (json.embeddings || []).map((item) => item.values);
}

module.exports = { chatJSON, embed, GoogleAIError };