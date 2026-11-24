// lib/kb.js — loads the versioned knowledge base, computes & caches embeddings for it,
// and provides a retrieval function used by every RAG-grounded agent.

const fs = require("fs");
const path = require("path");
const { embed } = require("./google");

const KB_PATH = path.join(__dirname, "..", "data", "knowledge-base.json");
const CACHE_PATH = process.env.KB_CACHE_PATH || path.join(__dirname, "..", "data", ".kb-embeddings-cache.json");
const EMBED_MODEL = process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";

let kbItems = null; // in-memory copy, embeddings attached lazily

function loadKB() {
  if (kbItems) return kbItems;
  const raw = JSON.parse(fs.readFileSync(KB_PATH, "utf8"));
  kbItems = raw.map((item) => ({ ...item }));
  return kbItems;
}

function contentHash(item) {
  // Cheap content fingerprint (no crypto dependency needed): length + a rolling sum.
  const s = item.title + "|" + item.content + "|" + item.version;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `${s.length}-${h}`;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}
function writeCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch (e) {
    // Non-fatal: worst case we recompute embeddings next run.
  }
}

/** Pure function: cosine similarity between two equal-length vectors. */
function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Pure function: rank pre-embedded items against a query vector. */
function rankByEmbedding(queryVec, items, topK) {
  return items
    .map((item) => ({ item, score: cosineSim(queryVec, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Ensures every KB item has an .embedding, computing+caching only what's missing/stale. */
async function ensureEmbeddings(apiKey) {
  const items = loadKB();
  const cache = readCache();
  const toCompute = [];
  for (const item of items) {
    const hash = `${EMBED_MODEL}:${contentHash(item)}`;
    const cached = cache[item.id];
    if (cached && cached.hash === hash) {
      item.embedding = cached.embedding;
    } else {
      toCompute.push({ item, hash });
    }
  }
  if (toCompute.length === 0) return items;

  // Batch in groups of 20 to keep individual requests small.
  for (let i = 0; i < toCompute.length; i += 20) {
    const batch = toCompute.slice(i, i + 20);
    const vectors = await embed({
      apiKey,
      model: EMBED_MODEL,
      input: batch.map((b) => `${b.item.title}\n${b.item.content}`),
    });
    batch.forEach((b, idx) => {
      b.item.embedding = vectors[idx];
      cache[b.item.id] = { hash: b.hash, embedding: vectors[idx] };
    });
  }
  writeCache(cache);
  return items;
}

/**
 * Retrieval-grounded lookup: filters by category + applicability (use case), then
 * ranks by semantic similarity to the query text. Returns topK items with scores,
 * each stripped of its embedding vector (the caller only needs the metadata+content).
 */
async function retrieve({ apiKey, query, useCase, categories, topK = 4 }) {
  const items = await ensureEmbeddings(apiKey);
  const pool = items.filter((item) => {
    const catOk = !categories || categories.includes(item.category);
    const appOk = !useCase || item.applicability.includes("all") || item.applicability.includes(useCase);
    return catOk && appOk;
  });
  if (pool.length === 0) return [];
  const [queryVec] = await embed({ apiKey, model: EMBED_MODEL, input: [query] });
  return rankByEmbedding(queryVec, pool, topK).map(({ item, score }) => ({
    id: item.id,
    category: item.category,
    title: item.title,
    content: item.content,
    source: item.source,
    jurisdiction: item.jurisdiction,
    effective_date: item.effective_date,
    version: item.version,
    score: Math.round(score * 1000) / 1000,
  }));
}

function listAll() {
  return loadKB().map(({ embedding, ...rest }) => rest);
}

module.exports = { loadKB, ensureEmbeddings, retrieve, listAll, cosineSim, rankByEmbedding, contentHash };
