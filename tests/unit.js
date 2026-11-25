// tests/unit.js — dependency-free checks for the pure retrieval logic and knowledge-base integrity.
const kb = require("../lib/kb");
const { applyComplianceRules } = require("../lib/complianceRules");
const { validateCitations } = require("../lib/agents/validation");
const { normalizeDocumentation } = require("../lib/documentation");
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
check("jurisdiction filtering retains global/group-wide evidence", kb.jurisdictionMatches("Group-wide", ["Canada"]) && kb.jurisdictionMatches("Global", ["Canada"]));
check("jurisdiction filtering accepts exact and slash-separated matches", kb.jurisdictionMatches("National / Canada", ["Canada"]) && kb.jurisdictionMatches("Canada", ["Canada"]));
check("jurisdiction filtering excludes ambiguous national evidence for a named country", !kb.jurisdictionMatches("National", ["Canada"]));
check("jurisdiction filtering is unrestricted only when no jurisdiction was supplied", kb.jurisdictionMatches("National", []));
const guarded = applyComplianceRules(
  [{ requirementId: "FR-001", status: "supported", citedEvidenceIds: ["REG-001"], confidence: 0.9 }],
  { jurisdictions: ["Canada"], retrievedEvidence: [{ id: "REG-001", source: "Regulation (illustrative summary)", jurisdiction: "Canada" }] },
);
check("rule-based compliance validation downgrades illustrative evidence", guarded.mappings[0].status === "unverified" && guarded.issues.length === 1);
check("citation validation is scoped to the agent's retrieved evidence", validateCitations([{ requirementId: "FR-001", citedEvidenceIds: ["REG-001"] }], [{ id: "POL-001" }]).length === 1);
const dashboardRequirements = [
  { id: "FR-001", type: "functional", source: "Project brief", statement: "Analysts can review fraud alerts." },
  { id: "NFR-001", type: "non-functional", source: "Project brief", statement: "The dashboard records investigation actions." },
];
const recoveredDocs = normalizeDocumentation(
  {
    srs: {
      title: "Fraud dashboard",
      useCases: [{ id: "UC-1", actors: "analyst", mainFlow: null }],
      userStories: [{ id: "US-1", acceptanceCriteria: "not-an-array", requirementIds: null }],
    },
    traceability: [{ requirementId: "UNKNOWN", source: "invented" }],
    retrievedEvidence: [{ id: "TPL-1" }],
  },
  {
    project: { title: "Fraud Monitoring Dashboard", description: "Review simulated payment fraud alerts." },
    requirements: dashboardRequirements,
    security: { findings: [{ statement: "Use role-scoped access." }] },
    compliance: { mappings: [{ gap: "Regulatory mapping is TBD." }] },
    risks: [{ id: "R-001" }],
    sdlc: { recommendedModel: "Hybrid", recommendationRationale: "Iterative review.", workflow: [] },
  },
);
check("partial SRS output is completed from validated project and requirement data", recoveredDocs.srs.title === "Fraud dashboard" && recoveredDocs.srs.scope === "Review simulated payment fraud alerts." && recoveredDocs.srs.functionalRequirements[0] === "FR-001" && recoveredDocs.srs.securityPrivacy[0] === "Use role-scoped access." && recoveredDocs.retrievedEvidence[0].id === "TPL-1");
check("malformed nested SRS fields are normalized for rendering", Array.isArray(recoveredDocs.srs.useCases[0].actors) && Array.isArray(recoveredDocs.srs.useCases[0].mainFlow) && Array.isArray(recoveredDocs.srs.userStories[0].acceptanceCriteria) && Array.isArray(recoveredDocs.srs.userStories[0].requirementIds));
check("traceability recovery emits exactly one valid row for every requirement", recoveredDocs.traceability.length === dashboardRequirements.length && recoveredDocs.traceability.every((item, index) => item.requirementId === dashboardRequirements[index].id && item.source === "Project brief"));
check("malformed documentation output still produces a safe SRS and traceability", normalizeDocumentation(null, { project: {}, requirements: dashboardRequirements }).traceability.length === 2);
console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
