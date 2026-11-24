// tests/unit.js — dependency-free checks for the pure retrieval logic and knowledge-base integrity.
const kb = require("../lib/kb");
let failed = 0;
const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) failed++; };

check("cosine of identical vectors is 1", kb.cosineSim([1, 0], [1, 0]) === 1);
check("cosine of orthogonal vectors is 0", kb.cosineSim([1, 0], [0, 1]) === 0);
const ranked = kb.rankByEmbedding([1, 0, 0], [{ id: "a", embedding: [1, 0, 0] }, { id: "b", embedding: [0, 1, 0] }, { id: "c", embedding: [0.9, 0.1, 0] }], 2);
check("ranking returns best matches first, respecting topK", ranked.length === 2 && ranked[0].item.id === "a" && ranked[1].item.id === "c");

const items = kb.listAll();
const cats = ["terminology", "policy", "regulation", "security-standard", "requirement-guideline", "sdlc-rule", "template", "approved-project"];
check("KB covers all 8 required categories", cats.every((c) => items.some((i) => i.category === c)));
check("KB ids are unique", new Set(items.map((i) => i.id)).size === items.length);
check("every KB item carries source, jurisdiction, effective_date, version, applicability", items.every((i) => i.source && i.jurisdiction && i.effective_date && i.version && Array.isArray(i.applicability) && i.applicability.length));
check("listAll never leaks embedding vectors", items.every((i) => !("embedding" in i)));
const a = { title: "T", content: "C", version: "1" };
check("content hash changes when content changes", kb.contentHash(a) !== kb.contentHash({ ...a, content: "D" }));
console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
