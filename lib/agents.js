// lib/agents.js — one function per agent in the architecture diagram. The Coordinator
// itself is not an LLM call: it's the orchestration logic in server.js that sequences
// these, carries shared context between them, and enforces the human-review gates.

const { chatJSON } = require("./google");
const kb = require("./kb");

const TOPICS = [
  "Business objectives",
  "Users and roles",
  "Existing workflow",
  "Inputs, outputs and business rules",
  "Exceptional conditions",
  "Data collection and retention",
  "Authentication and authorisation",
  "Financial transaction limits",
  "Audit and reporting requirements",
  "Performance and availability",
  "Integration with existing systems",
  "Regulatory and security constraints",
  "Expected project schedule and budget",
];

/** Stakeholder Interaction Agent — one conversational turn. */
async function interviewTurn({ apiKey, model, useCase, roleLabel, transcript }) {
  const sys = {
    role: "system",
    content: `You are the Stakeholder Interaction Agent, interviewing a "${roleLabel}" about a financial software initiative called "${useCase.name}": ${useCase.sample}

Conduct an adaptive interview — not a fixed questionnaire. Cover ground across whichever of these topics are relevant to this stakeholder's perspective (skip ones that clearly aren't their area, e.g. budget for a security reviewer, but don't skip a topic just because it's hard to ask about): ${TOPICS.join("; ")}.

Rules:
- Ask exactly ONE question per turn.
- After the stakeholder answers, judge it against what they've already said. If it is vague (no measurable detail), incomplete (missing an obvious part of the question), or inconsistent with an earlier answer, ask a targeted follow-up that names what's missing or conflicting — do not move to a new topic yet.
- Keep questions conversational and grounded in what's already been said, not generic or repeated.
- Stop when you judge the relevant topics have been adequately covered for this role — usually after 5 to 10 exchanges, fewer if the role only has a narrow area of relevance. When stopping, set done=true and the message should be a brief closing remark, not a new question.
Respond ONLY with JSON: {"message": "<your next question, follow-up, or closing remark>", "done": false, "topicsCovered": ["..."]}`,
  };
  const msgs = transcript.map((t) => ({ role: t.speaker === "agent" ? "assistant" : "user", content: t.text }));
  return chatJSON({ apiKey, model, messages: [sys, ...msgs], maxTokens: 400 });
}

function interviewsToText(interviews) {
  return interviews
    .map((iv) => `[Stakeholder role: ${iv.roleLabel}]\n` + iv.transcript.map((t) => `${t.speaker === "agent" ? "Q" : "A"}: ${t.text}`).join("\n"))
    .join("\n\n");
}
function sourcesToText(sources) {
  if (!sources.length) return "(none provided)";
  return sources.map((s) => `[Input source: ${s.type} — sensitive fields already masked]\n${s.masked}`).join("\n\n");
}

/** Requirement Extraction Agent. */
async function extract({ apiKey, model, useCase, interviews, sources }) {
  const messages = [
    {
      role: "system",
      content: `You are the Requirement Extraction Agent. Extract candidate requirements from the material provided — do not classify, prioritise or score them yet, just identify them as plain statements. Each statement should follow "The system shall <capability> for <actor> under <condition>" where the source material supports it. Draw from every interview and source actually provided. Output JSON only: {"requirements":[{"tempId":"T1","statement":"...","sourceRole":"the specific stakeholder role or input-source type this came from"}]}. Produce 8-14 requirements.`,
    },
    {
      role: "user",
      content: `Use case: ${useCase.name}\n\nSTAKEHOLDER INTERVIEWS:\n${interviewsToText(interviews)}\n\nADDITIONAL INPUT SOURCES:\n${sourcesToText(sources)}`,
    },
  ];
  return chatJSON({ apiKey, model, messages, maxTokens: 3000 });
}

/** Clarification Agent — grounded in the knowledge base's requirement-engineering guidelines. */
async function clarify({ apiKey, model, useCase, requirements }) {
  const guidelines = await kb.retrieve({
    apiKey,
    query: "ambiguous or incomplete requirement, measurable acceptance criteria, subjective terms",
    useCase: useCase && useCase.id,
    categories: ["requirement-guideline"],
    topK: 3,
  });
  const guidelineText = guidelines.length ? guidelines.map((g) => `- [${g.id}] ${g.title}: ${g.content}`).join("\n") : "- (no guideline retrieved; use standard requirements-engineering practice)";
  const messages = [
    {
      role: "system",
      content: `You are the Clarification Agent. Apply these approved requirement-engineering guidelines when judging each requirement:\n${guidelineText}\n\nReview each requirement below. Output JSON only: {"items":[{"tempId":"T1","status":"clear","question":null}]} — for any item that is incomplete or ambiguous under the guidelines above, set status to "needs_clarification" and question to one specific, answerable question that would resolve it. Do not flag requirements that are already clear and testable.`,
    },
    { role: "user", content: JSON.stringify(requirements.map((r) => ({ tempId: r.tempId, statement: r.statement }))) },
  ];
  return chatJSON({ apiKey, model, messages, maxTokens: 2000 });
}

/** Classification + Conflict-Detection Agent. */
async function classifyAndDetectConflicts({ apiKey, model, useCase, requirements }) {
  const messages = [
    {
      role: "system",
      content: `You are the Classification Agent and the Conflict-Detection Agent, run together. For each requirement, assign: a permanent id in the form FR-<CODE>-00N or NFR-<CODE>-00N (CODE = a short use-case code you choose), categories (one or more of Functional, Security, Compliance, Performance, Usability), and priority (High/Medium/Low). Then separately, review the full set for contradictions or near-duplicates. Output JSON only: {"requirements":[{"tempId":"T1","id":"FR-PAY-001","statement":"...","sourceRole":"...","categories":["Functional"],"priority":"High"}],"conflicts":[{"a":"FR-PAY-001","b":"FR-PAY-004","description":"why these conflict or duplicate"}]}. Omit "conflicts" entries if there are none — do not invent conflicts.`,
    },
    { role: "user", content: `Use case: ${useCase.name}\n\n` + JSON.stringify(requirements) },
  ];
  return chatJSON({ apiKey, model, messages, maxTokens: 3000 });
}

/** Compliance + Security/Privacy Agent — retrieval-grounded. */
async function assessComplianceAndSecurity({ apiKey, model, useCase, requirements }) {
  const evidenceByReq = {};
  for (const r of requirements) {
    evidenceByReq[r.id] = await kb.retrieve({
      apiKey,
      query: r.statement,
      useCase: useCase.id,
      categories: ["regulation", "security-standard", "policy", "approved-project"],
      topK: 4,
    });
  }
  const evidenceBlock = requirements
    .map((r) => `Requirement ${r.id}: "${r.statement}"\nEvidence:\n` + (evidenceByReq[r.id].length ? evidenceByReq[r.id].map((e) => `- [${e.id}] ${e.title} (${e.source}, ${e.jurisdiction}, v${e.version}): ${e.content}`).join("\n") : "- (no relevant evidence retrieved)"))
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content: `You are the Compliance Agent and the Security & Privacy Agent, run together, using Retrieval-Augmented Generation. Evidence may include prior approved projects, which you may cite as precedent. For each requirement you are given ONLY the retrieved evidence shown — you must not cite or rely on any regulation, policy or standard that is not in that evidence. For each requirement: if the evidence supports a compliance or security mapping, state it and cite the evidence id(s) you used (citedEvidenceIds), with a confidence 0-1 reflecting how directly the evidence supports the mapping. If no evidence is relevant, set regulation to null, confidence to 0.2 or lower, and gap to a short note — do NOT invent a citation. You may also propose at most 2 new derived security/privacy requirements if the evidence clearly calls for something not yet covered. Output JSON only: {"compliance":[{"requirementId":"FR-PAY-001","regulation":"name or null","jurisdiction":"...","citedEvidenceIds":["REG-002"],"confidence":0.9,"gap":"None"}],"derivedSecurityRequirements":[{"statement":"...","citedEvidenceIds":["SEC-002"],"basedOnRequirementId":"FR-PAY-001"}]}`,
    },
    { role: "user", content: evidenceBlock },
  ];
  const result = await chatJSON({ apiKey, model, messages, maxTokens: 3000 });
  result._evidenceByReq = evidenceByReq; // kept for the UI's citation drill-down
  return result;
}

/** Risk-Analysis Agent. */
async function assessRisk({ apiKey, model, useCase, requirements, compliance }) {
  const messages = [
    {
      role: "system",
      content: `You are the Risk-Analysis Agent. Given the requirements and their compliance mappings (including any gaps or low-confidence mappings), identify 4-7 business, technical, security and compliance risks. Weight gaps/low-confidence compliance items as elevated risk. Output JSON only: {"risks":[{"id":"R-01","description":"...","category":"Security","severity":"High","relatedRequirementIds":["FR-PAY-001"]}]}`,
    },
    { role: "user", content: `Use case: ${useCase.name}\n\nRequirements: ${JSON.stringify(requirements)}\n\nCompliance: ${JSON.stringify(compliance)}` },
  ];
  return chatJSON({ apiKey, model, messages, maxTokens: 2000 });
}

/** SDLC-Selection Agent — retrieval-grounded. */
async function selectSDLC({ apiKey, model, useCase, requirements, risks }) {
  const evidence = await kb.retrieve({ apiKey, query: `SDLC selection for ${useCase.name}: ${requirements.map((r) => r.statement).join("; ")}`, useCase: useCase.id, categories: ["sdlc-rule"], topK: 6 });
  const evidenceText = evidence.length
    ? evidence.map((e) => `- [${e.id}] ${e.title}: ${e.content}`).join("\n")
    : "- (no relevant SDLC rules retrieved)";
  const messages = [
    {
      role: "system",
      content: `You are the SDLC-Selection Agent, using Retrieval-Augmented Generation. Using ONLY the retrieved SDLC rules below as evidence, score candidate models 0-100 for THIS initiative's specific requirement/risk profile, citing the evidence id(s) that justify each score (citedEvidenceIds). Choose the 6 most relevant candidates from: Waterfall, V-Model, Iterative, Agile, Spiral, Lean/Kanban, DevSecOps, Agile-DevSecOps hybrid. Each needs exactly 2 pros and 2 cons. Then produce a 5-6 phase workflow (activities, responsible role, approval gate) tailored to the top-scoring candidate. Output JSON only: {"candidates":[{"model":"","pct":80,"justification":"","citedEvidenceIds":["SDLC-003"],"pros":["",""],"cons":["",""]}],"workflow":[{"phase":"","activities":["",""],"role":"","gate":""}]}`,
    },
    { role: "user", content: `Use case: ${useCase.name}\n\nRetrieved SDLC rules:\n${evidenceText}\n\nRequirements: ${JSON.stringify(requirements.map((r) => r.statement))}\n\nRisks: ${JSON.stringify(risks)}` },
  ];
  const result = await chatJSON({ apiKey, model, messages, maxTokens: 3000 });
  result._evidence = evidence;
  return result;
}

/** Documentation + Validation Agent — uses the knowledge base's SRS template and traceability guideline. */
async function documentAndValidate({ apiKey, model, useCase, requirements, compliance, conflicts }) {
  const templates = await kb.retrieve({
    apiKey,
    query: "software requirements specification outline and traceability matrix",
    useCase: useCase && useCase.id,
    categories: ["template", "requirement-guideline"],
    topK: 3,
  });
  const templateText = templates.length ? templates.map((t) => `- [${t.id}] ${t.title}: ${t.content}`).join("\n") : "- (no template retrieved)";
  const messages = [
    {
      role: "system",
      content: `You are the Documentation Agent and the Validation Agent, run together. Approved templates and guidelines to follow:\n${templateText}\n\nFirst, produce one traceability row per requirement, naming the real stakeholder role or input source it came from (from its sourceRole field) and an artifact reference that points to the matching section of the SRS outline above. Second, validate the full set: mark a requirement needsReview=true if it has no compliance mapping, if its compliance confidence is below 0.6, or if it appears in the conflicts list — give a short reason each time. Output JSON only: {"traceability":[{"requirementId":"FR-PAY-001","source":"...","artifact":"SRS §3"}],"validation":[{"requirementId":"FR-PAY-001","needsReview":true,"reason":"..."}]}. Only include a validation entry when needsReview is true.`,
    },
    { role: "user", content: `Requirements: ${JSON.stringify(requirements)}\n\nCompliance: ${JSON.stringify(compliance)}\n\nConflicts: ${JSON.stringify(conflicts || [])}` },
  ];
  return chatJSON({ apiKey, model, messages, maxTokens: 2500 });
}

module.exports = { TOPICS, interviewTurn, extract, clarify, classifyAndDetectConflicts, assessComplianceAndSecurity, assessRisk, selectSDLC, documentAndValidate };
