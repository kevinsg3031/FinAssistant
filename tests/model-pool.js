process.env.GOOGLE_MODEL_POOL = "primary,fallback";
process.env.GOOGLE_EMBEDDING_MODEL_POOL = "embedding-primary,embedding-fallback";
process.env.GOOGLE_MAX_CONCURRENT_CALLS = "1";
process.env.GOOGLE_RETRY_BASE_MS = "1";
process.env.GOOGLE_RETRY_MAX_MS = "5";
process.env.GOOGLE_MAX_CAPACITY_RETRIES = "2";
process.env.GOOGLE_REQUEST_TIMEOUT_MS = "10";

const { chatJSON, embed, GoogleAIError, isCapacityFailure, configuredModels, DEFAULT_GENERATION_POOL } = require("../lib/google");

let active = 0;
let maxActive = 0;
let primaryFailures = 0;
let embeddingFailures = 0;
let rejectAuth = false;
let rejectNetwork = false;
let rejectCapacity = false;
let timeoutPrimary = false;
let highDemandFailures = 0;
let retryRoundFailures = 0;
const calls = [];
global.fetch = async (url, options) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  const model = decodeURIComponent(String(url).split("/models/")[1].split(":")[0]);
  const body = JSON.parse(options.body);
  const isEmbedding = String(url).includes(":batchEmbedContents");
  const prompt = body.contents?.at(-1)?.parts?.[0]?.text || "";
  calls.push({ model, isEmbedding });
  if (timeoutPrimary && !isEmbedding && model === "primary") {
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 3));
  active -= 1;

  if (rejectNetwork) throw new Error("Network unavailable");
  if (rejectCapacity) {
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }) };
  }
  if (!isEmbedding && model === "primary" && highDemandFailures++ === 0) {
    return {
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ error: { message: "This model is currently experiencing high demand. Please try again later." } }),
    };
  }
  if (rejectAuth) {
    return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({ error: { message: "Invalid credentials" } }) };
  }
  if (!isEmbedding && prompt.includes("retry-round") && retryRoundFailures++ < 2) {
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }) };
  }
  if (!isEmbedding && model === "primary" && primaryFailures++ === 0) {
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }) };
  }
  if (isEmbedding && model === "embedding-primary" && embeddingFailures++ === 0) {
    return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: { message: "Service temporarily unavailable" } }) };
  }
  if (isEmbedding) {
    return { ok: true, status: 200, json: async () => ({ embeddings: body.requests.map(() => ({ values: [0.1, 0.2] })) }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true }) }] } }] }),
  };
};

const message = (text) => [{ role: "user", content: text }];
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failed += 1;
};

(async () => {
  try {
    const [first, second] = await Promise.all([
      chatJSON({ apiKey: "test", model: "primary", messages: message("first") }),
      chatJSON({ apiKey: "test", model: "primary", messages: message("second") }),
    ]);
    check("temporary capacity errors rotate to the fallback model", first.ok && calls.some((call) => call.model === "fallback"));
    check("queued model requests complete successfully", second.ok);
    check("concurrent provider calls respect the configured limit", maxActive === 1);
    check("default generation pool includes four current stable model choices", DEFAULT_GENERATION_POOL.length === 4 && DEFAULT_GENERATION_POOL[0] === "gemini-3.8-flash" && DEFAULT_GENERATION_POOL.includes("gemini-3.6-flash") && DEFAULT_GENERATION_POOL.includes("gemini-3.5-flash-lite") && DEFAULT_GENERATION_POOL.includes("gemini-3.1-flash-lite"));
    check("preferred model is first while all default fallbacks remain configured", configuredModels("gemini-3.8-flash", "UNSET_MODEL_POOL_TEST", DEFAULT_GENERATION_POOL).length === 4);
    check("high-demand response text triggers fallback even with HTTP 400", isCapacityFailure(400, { error: { message: "This model is currently experiencing high demand. Please try again later." } }));
    const highDemandResult = await chatJSON({ apiKey: "test", model: "primary", messages: message("high demand") });
    check("high-demand response rotates to another model", highDemandResult.ok && calls.some((call) => call.model === "fallback"));

    await chatJSON({ apiKey: "test", model: "primary", messages: message("prepare timeout test") });
    timeoutPrimary = true;
    const callsBeforeTimeout = calls.length;
    const timeoutFallback = await chatJSON({ apiKey: "test", model: "primary", messages: message("slow primary") });
    const timeoutCalls = calls.slice(callsBeforeTimeout);
    check("timed-out primary model falls back without ending the chat", timeoutFallback.ok && timeoutCalls.length === 2 && timeoutCalls[0].model === "primary" && timeoutCalls[1].model === "fallback");
    timeoutPrimary = false;

    const callsBeforeRetryRound = calls.length;
    const retried = await chatJSON({ apiKey: "test", model: "primary", messages: message("retry-round") });
    check("requests retry after every model is temporarily at capacity", retried.ok && calls.length === callsBeforeRetryRound + 3);

    const vectors = await embed({ apiKey: "test", model: "embedding-primary", input: ["sample"] });
    check("embedding calls rotate to their configured fallback", vectors.length === 1 && vectors[0][0] === 0.1 && calls.some((call) => call.model === "embedding-fallback"));

    rejectCapacity = true;
    const callsBeforeCapacityFailure = calls.length;
    let capacityError;
    try {
      await chatJSON({ apiKey: "test", model: "primary", messages: message("capacity-failure") });
    } catch (error) {
      capacityError = error;
    }
    check("persistent capacity failure terminates after bounded retries", capacityError instanceof GoogleAIError && capacityError.code === "capacity_exhausted" && calls.length === callsBeforeCapacityFailure + 6);
    rejectCapacity = false;

    rejectNetwork = true;
    const callsBeforeNetworkFailure = calls.length;
    let networkError;
    try {
      await chatJSON({ apiKey: "test", model: "primary", messages: message("network") });
    } catch (error) {
      networkError = error;
    }
    check("network failures terminate instead of leaving analysis pending", networkError instanceof GoogleAIError && networkError.code === "network" && calls.length === callsBeforeNetworkFailure + 1);
    rejectNetwork = false;

    rejectAuth = true;
    const callsBeforeAuthFailure = calls.length;
    let authError;
    try {
      await chatJSON({ apiKey: "test", model: "primary", messages: message("auth") });
    } catch (error) {
      authError = error;
    }
    check("non-capacity errors are returned without futile model rotation", authError instanceof GoogleAIError && authError.code === "auth" && calls.length === callsBeforeAuthFailure + 1);
  } catch (error) {
    console.error(error);
    failed += 1;
  }

  console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
