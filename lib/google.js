// lib/google.js — minimal wrapper around the Google AI Studio Gemini API.
// No SDK dependency: plain fetch, so the whole project stays npm-install-free.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_CONCURRENCY = positiveInteger(process.env.GOOGLE_MAX_CONCURRENT_CALLS, 3);
const RETRY_BASE_MS = positiveInteger(process.env.GOOGLE_RETRY_BASE_MS, 1000);
const RETRY_MAX_MS = positiveInteger(process.env.GOOGLE_RETRY_MAX_MS, 60000);
const MAX_CAPACITY_RETRIES = nonNegativeInteger(process.env.GOOGLE_MAX_CAPACITY_RETRIES, 8);
const REQUEST_TIMEOUT_MS = positiveInteger(process.env.GOOGLE_REQUEST_TIMEOUT_MS, 30000);
const DEFAULT_GENERATION_POOL = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

class GoogleAIError extends Error {
  constructor(message, code, status, retryAfterMs = 0) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMilliseconds(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now());
}

function isCapacityFailure(status, payload) {
  if ([408, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  const reason = payload?.error?.status || payload?.error?.details?.[0]?.reason || "";
  const message = payload?.error?.message || "";
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|OVERLOADED|RATE_LIMIT|QUOTA|HIGH DEMAND|TRY AGAIN LATER|TEMPORARILY UNAVAILABLE/i.test(`${reason} ${message}`);
}

function classifyStatus(status, payload) {
  if (isCapacityFailure(status, payload)) return "capacity";
  if (status === 401 || status === 403) return "auth";
  return "other";
}

async function readResponse(res, action) {
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new GoogleAIError(
      `Google AI returned a non-JSON response (HTTP ${res.status}).`,
      classifyStatus(res.status),
      res.status,
      retryAfterMilliseconds(res.headers?.get?.("retry-after")),
    );
  }
  if (!res.ok) {
    throw new GoogleAIError(
      json.error?.message || `Google AI ${action} API error.`,
      classifyStatus(res.status, json),
      res.status,
      retryAfterMilliseconds(res.headers?.get?.("retry-after")),
    );
  }
  return json;
}

const requestQueue = [];
let activeRequests = 0;
let nextChatModel = 0;
let nextEmbeddingModel = 0;

function runQueued(operation) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ operation, resolve, reject });
    processQueue();
  });
}

function processQueue() {
  while (activeRequests < REQUEST_CONCURRENCY && requestQueue.length) {
    const task = requestQueue.shift();
    activeRequests += 1;
    Promise.resolve()
      .then(task.operation)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeRequests -= 1;
        processQueue();
      });
  }
}

function configuredModels(preferred, poolVariable, defaultModels) {
  const configured = (process.env[poolVariable] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const models = configured.length ? configured : defaultModels;
  if (preferred && !models.includes(preferred)) models.unshift(preferred);
  return [...new Set(models)];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestWithModelPool({ models, getNextIndex, invoke }) {
  let retries = 0;
  while (true) {
    const startIndex = getNextIndex(models.length);
    let retryAfterMs = 0;
    let sawCapacityFailure = false;
    let timeoutError = null;
    for (let offset = 0; offset < models.length; offset += 1) {
      const model = models[(startIndex + offset) % models.length];
      try {
        return await runQueued(() => invoke(model));
      } catch (error) {
        if (!(error instanceof GoogleAIError) || !["capacity", "timeout"].includes(error.code)) throw error;
        if (error.code === "capacity") {
          sawCapacityFailure = true;
          retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs || 0);
        } else {
          timeoutError = error;
        }
      }
    }

    if (timeoutError && !sawCapacityFailure) {
      throw new GoogleAIError(
        `All configured models timed out. The last request exceeded ${REQUEST_TIMEOUT_MS} ms; configure a fallback model or try again later.`,
        "timeout",
        504,
      );
    }

    if (retries >= MAX_CAPACITY_RETRIES) {
      throw new GoogleAIError(
        "The model service remained unavailable after automatic retries. The analysis could not be completed; please try again later.",
        "capacity_exhausted",
        503,
      );
    }

    retries += 1;
    const exponentialDelay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(retries - 1, 10)));
    const jitteredDelay = Math.floor(exponentialDelay * (0.75 + Math.random() * 0.5));
    await delay(Math.min(RETRY_MAX_MS, Math.max(retryAfterMs, jitteredDelay)));
  }
}

async function requestJSON({ model, apiKey, url, body, action }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body(model)),
      signal: controller.signal,
    });
    return await readResponse(response, action);
  } catch (error) {
    if (error instanceof GoogleAIError) throw error;
    if (error.name === "AbortError") {
      throw new GoogleAIError(`The model service request timed out after ${REQUEST_TIMEOUT_MS} ms.`, "timeout", 504);
    }
    throw new GoogleAIError(`Could not connect to the model service: ${error.message}`, "network", 0);
  } finally {
    clearTimeout(timeout);
  }
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

  const models = configuredModels(model, "GOOGLE_MODEL_POOL", DEFAULT_GENERATION_POOL);
  const data = await requestWithModelPool({
    models,
    getNextIndex: (length) => {
      const index = nextChatModel % length;
      nextChatModel = (nextChatModel + 1) % length;
      return index;
    },
    invoke: (selectedModel) => requestJSON({
      model: selectedModel,
      apiKey,
      url: `${API_BASE}/models/${encodeURIComponent(selectedModel)}:generateContent`,
      action: "generateContent",
      body: () => ({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json" },
      }),
    }),
  });
  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new GoogleAIError("The model did not return valid JSON.", "other", 502);
  }
}

/** Calls Gemini batchEmbedContents and returns an array of number[] vectors. */
async function embed({ apiKey, model = "gemini-embedding-001", input }) {
  const models = configuredModels(model, "GOOGLE_EMBEDDING_MODEL_POOL", [model]);
  const json = await requestWithModelPool({
    models,
    getNextIndex: (length) => {
      const index = nextEmbeddingModel % length;
      nextEmbeddingModel = (nextEmbeddingModel + 1) % length;
      return index;
    },
    invoke: (selectedModel) => requestJSON({
      model: selectedModel,
      apiKey,
      url: `${API_BASE}/models/${encodeURIComponent(selectedModel)}:batchEmbedContents`,
      action: "embedding",
      body: (embeddingModel) => ({
        requests: input.map((text) => ({
          model: `models/${embeddingModel}`,
          content: { parts: [{ text }] },
        })),
      }),
    }),
  });
  return (json.embeddings || []).map((item) => item.values);
}

module.exports = { chatJSON, embed, GoogleAIError, configuredModels, isCapacityFailure, DEFAULT_GENERATION_POOL };