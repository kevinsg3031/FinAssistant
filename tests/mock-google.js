// tests/mock-google.js — preloaded with `node -r ./tests/mock-google.js server.js`.
// Replaces fetch() for Google AI Studio with a deterministic fake so the pipeline can be
// tested offline. It is a TEST HARNESS ONLY and logs evidence ids to verify retrieval.

const fs = require("fs");
const realFetch = global.fetch;
const LOG = process.env.MOCK_LOG || "/tmp/mock-google-log.jsonl";

function hashVec(text, dims = 128) {
  const v = new Array(dims).fill(0);
  text.toLowerCase().split(/\W+/).filter(Boolean).forEach((w) => {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % dims] += 1;
  });
  return v;
}
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
const chat = (obj) => ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const evidenceIds = (text) => [...new Set([...text.matchAll(/\[([A-Z]+-\d{3})\]/g)].map((m) => m[1]))];

global.fetch = async (url, opts) => {
  if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return realFetch(url, opts);
  const body = JSON.parse(opts.body);

  if (String(url).includes(":batchEmbedContents")) {
    return ok({ embeddings: body.requests.map((request) => ({ values: hashVec(request.content.parts.map((p) => p.text).join("")) })) });
  }

  const systemText = body.systemInstruction?.parts.map((part) => part.text).join("\n") || "";
  const contents = body.contents || [];
  const all = [systemText, ...contents.flatMap((item) => item.parts.map((part) => part.text || ""))].join("\n");
  const userContents = contents.filter((item) => item.role === "user" && item.parts.map((part) => part.text).join("") !== "Begin the interview.");
  const userTurns = userContents.length;
  const user = contents.filter((item) => item.role === "user").at(-1)?.parts.map((part) => part.text || "").join("") || "";
  const log = (agent) => fs.appendFileSync(LOG, JSON.stringify({ agent, evidenceIds: evidenceIds(all) }) + "\n");

  if (systemText.includes("Stakeholder Interaction Agent")) {
    log("interview");
    if (userTurns === 0) return chat({ message: "What business objective is this initiative meant to achieve?", done: false, topicsCovered: [] });
    if (userTurns === 1) return chat({ message: "You said it should be fast — can you put a number on that?", done: false, topicsCovered: ["Business objectives"] });
    if (userTurns === 2) return chat({ message: "What authentication is needed for high-value transfers?", done: false, topicsCovered: ["Business objectives", "Performance and availability"] });
    return chat({ message: "Thanks — that covers what I needed.", done: true, topicsCovered: ["Business objectives", "Authentication and authorisation"] });
  }
  if (systemText.includes("Requirement Extraction Agent")) {
    log("extract");
    return chat({ requirements: [
      { tempId: "T1", statement: "The system shall encrypt all payment messages in transit for all customers.", sourceRole: "Information-security teams" },
      { tempId: "T2", statement: "The system shall be fast.", sourceRole: "Business analysts" },
      { tempId: "T3", statement: "The system shall screen every cross-border payment against sanctions lists before settlement.", sourceRole: "Compliance & legal officers" },
      { tempId: "T4", statement: "The system shall log every payment decision for audit.", sourceRole: "Auditors & regulators" },
    ] });
  }
  if (systemText.includes("Clarification Agent")) {
    log("clarify");
    const reqs = JSON.parse(user);
    return chat({ items: reqs.map((r) => (/\bfast\b/.test(r.statement) && !r.statement.includes("Clarification:")
      ? { tempId: r.tempId, status: "needs_clarification", question: 'What specific latency target defines "fast"?' }
      : { tempId: r.tempId, status: "clear", question: null })) });
  }
  if (systemText.includes("Classification Agent")) {
    log("classify");
    const reqs = JSON.parse(user.slice(user.indexOf("[")));
    return chat({
      requirements: reqs.map((r, i) => ({ ...r, id: `FR-TST-00${i + 1}`, categories: [i === 0 ? "Security" : "Functional"], priority: i === 1 ? "Medium" : "High" })),
      conflicts: [{ a: "FR-TST-001", b: "FR-TST-002", description: "Encryption overhead may conflict with the unquantified speed requirement." }],
    });
  }
  if (systemText.includes("Compliance Agent")) {
    log("compliance");
    const sections = user.split(/\n\n(?=Requirement )/);
    const compliance = sections.map((sec) => {
      const id = sec.match(/^Requirement (\S+):/)[1];
      const ev = evidenceIds(sec);
      const slow = /\bfast\b/.test(sec.split("\n")[0]);
      if (!ev.length || slow) return { requirementId: id, regulation: null, jurisdiction: null, citedEvidenceIds: [], confidence: 0.4, gap: "No directly supporting evidence retrieved" };
      return { requirementId: id, regulation: `Mapped via ${ev[0]}`, jurisdiction: "Group-wide", citedEvidenceIds: [ev[0]], confidence: 0.85, gap: "None" };
    });
    const sec = evidenceIds(user).find((i) => i.startsWith("SEC-"));
    return chat({ compliance, derivedSecurityRequirements: sec ? [{ statement: "The system shall log every step-up authentication challenge.", citedEvidenceIds: [sec], basedOnRequirementId: compliance[0].requirementId }] : [] });
  }
  if (systemText.includes("Risk-Analysis Agent")) {
    log("risk");
    return chat({ risks: [
      { id: "R-01", description: "Duplicate debit on retry without idempotency", category: "Operational", severity: "High", relatedRequirementIds: ["FR-TST-001"] },
      { id: "R-02", description: "Unquantified performance target", category: "Technical", severity: "Medium", relatedRequirementIds: ["FR-TST-002"] },
    ] });
  }
  if (systemText.includes("SDLC-Selection Agent")) {
    log("sdlc");
    const ids = evidenceIds(user);
    const models = ["Agile-DevSecOps hybrid", "V-Model", "Agile", "Spiral", "Waterfall", "Lean/Kanban"];
    return chat({
      candidates: models.map((m, i) => ({ model: m, pct: 92 - i * 7, justification: `Scored against retrieved rules for ${m}.`, citedEvidenceIds: ids.length ? [ids[i % ids.length]] : [], pros: ["Pro A", "Pro B"], cons: ["Con A", "Con B"] })),
      workflow: ["Design", "Build", "Test", "Security review", "Release"].map((p) => ({ phase: p, activities: ["Activity 1", "Activity 2"], role: "Tech Lead", gate: `${p} sign-off` })),
    });
  }
  if (systemText.includes("Documentation Agent")) {
    log("document");
    const reqs = JSON.parse(user.match(/Requirements: (\[.*?\])\n\nCompliance/s)[1]);
    const comp = JSON.parse(user.match(/Compliance: (\[.*?\])\n\nConflicts/s)[1]);
    return chat({
      traceability: reqs.map((r) => ({ requirementId: r.id, source: r.sourceRole, artifact: "SRS §3" })),
      validation: comp.filter((c) => c.confidence < 0.6).map((c) => ({ requirementId: c.requirementId, needsReview: true, reason: "Low compliance-mapping confidence" })),
    });
  }
  return chat({});
};