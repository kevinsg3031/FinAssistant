// Deterministic local model substitute used only by automated tests.
const fs = require("fs");
const realFetch = global.fetch;
const LOG = process.env.MOCK_LOG || "/tmp/mock-google-log.jsonl";
let clarificationCalls = 0;

function hashVec(text, dims = 128) {
  const vector = new Array(dims).fill(0);
  text.toLowerCase().split(/\W+/).filter(Boolean).forEach((word) => {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % dims] += 1;
  });
  return vector;
}
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const chat = (value) => ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
const evidenceIds = (text) => [...new Set([...text.matchAll(/\[([A-Z]+-\d{3})\]/g)].map((match) => match[1]))];
const appendLog = (agent, text) => fs.appendFileSync(LOG, `${JSON.stringify({ agent, evidenceIds: evidenceIds(text) })}\n`);
const retrievedIds = (text) => evidenceIds(text.split("Retrieved evidence:\n").at(-1) || "");
const currentInput = (body) => {
  const text = body.contents?.filter((item) => item.role === "user").at(-1)?.parts.map((part) => part.text || "").join("") || "{}";
  try { return JSON.parse(text); } catch { return {}; }
};

global.fetch = async (url, options) => {
  if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return realFetch(url, options);
  const body = JSON.parse(options.body);
  if (String(url).includes(":batchEmbedContents")) {
    return ok({ embeddings: body.requests.map((request) => ({ values: hashVec(request.content.parts.map((part) => part.text).join("")) })) });
  }
  const system = body.systemInstruction?.parts.map((part) => part.text).join("\n") || "";
  const user = body.contents?.filter((item) => item.role === "user").at(-1)?.parts.map((part) => part.text || "").join("") || "";
  const allText = [system, user].join("\n");
  const input = currentInput(body);

  if (system.includes("Stakeholder Interaction Agent")) {
    appendLog("stakeholderInteraction", allText);
    const jurisdiction = /canada/i.test(`${input.project?.description || ""} ${input.userMessage || ""} ${JSON.stringify(input.conversation || [])}`) ? ["Canada"] : [];
    return chat({
      message: input.conversation?.length > 1
        ? "Thanks, that gives me enough to begin. Any undecided details can be marked TBD and reviewed later."
        : "1. What should the customer be able to accomplish? 2. Which country or region is this for? High-level answers are fine; anything undecided can be marked TBD.",
      topicsCovered: ["payment processing", "performance", "jurisdiction"],
      jurisdictionsMentioned: jurisdiction,
    });
  }
  if (system.includes("Requirement Extraction Agent")) {
    appendLog("requirementExtraction", allText);
    const answer = (input.conversation || []).map((item) => item.text).join(" ");
    const target = /two seconds|2 seconds/i.test(answer) ? "within 2 seconds" : "within a target time";
    return chat({ requirements: [
      { tempId: "T1", statement: "The system shall let a customer initiate a domestic payment transfer.", type: "functional", dimension: "business", source: "Project conversation", sourceExcerpt: "Customers can initiate a domestic payment." },
      { tempId: "T2", statement: `The system shall complete a payment transfer ${target}.`, type: "non-functional", dimension: "performance", source: "Project conversation", sourceExcerpt: answer.slice(-160) },
      { tempId: "T3", statement: "The system shall record each payment decision for later audit.", type: "non-functional", dimension: "auditability", source: "Project conversation", sourceExcerpt: "Record every payment decision for audit." },
    ], assumptions: [] });
  }
  if (system.includes("Clarification Agent")) {
    appendLog("clarification", allText);
    clarificationCalls += 1;
    return clarificationCalls === 1
      ? chat({ questions: [
        { id: "Q1", requirementRef: "T2", question: "What is a high-level acceptable payment-completion time, or should this be marked TBD?", reason: "This helps frame performance review." },
        { id: "Q2", requirementRef: "project", question: "Should partner selection remain open for now?", reason: "This distinguishes a fixed integration constraint from an undecided choice." },
      ], ready: false })
      : chat({ questions: [], ready: true });
  }
  if (system.includes("Classification Agent")) {
    appendLog("classification", allText);
    return chat({ requirements: (input.requirements || []).map((item, index) => ({
      ...item,
      type: item.type || (index === 0 ? "functional" : "non-functional"),
      dimensions: [item.dimension || "business"],
      priority: index === 0 ? "High" : "Medium",
      confidence: 0.91,
    })) });
  }
  if (system.includes("Conflict-Detection Agent")) {
    appendLog("conflictDetection", allText);
    return chat({ findings: [] });
  }
  if (system.includes("Compliance Agent")) {
    appendLog("compliance", allText);
    const ids = retrievedIds(system);
    return chat({ mappings: (input.requirements || []).map((requirement) => ({
      requirementId: requirement.id,
      obligation: null,
      jurisdiction: input.project?.jurisdictions?.join(", ") || "unspecified",
      status: "unverified",
      citedEvidenceIds: ids.slice(0, 1),
      confidence: 0.45,
      gap: "The illustrative seed evidence is not an authoritative legal source.",
    })) });
  }
  if (system.includes("Security and Privacy Agent")) {
    appendLog("securityPrivacy", allText);
    return chat({ findings: [{ requirementId: null, kind: "security", statement: "Use least-privilege access for payment operations.", threatOrConcern: "Unauthorised access to payment controls.", control: "Define and verify role-scoped access controls.", citedEvidenceIds: [], confidence: 0.7, needsReview: true }] });
  }
  if (system.includes("Risk-Analysis Agent")) {
    appendLog("riskAnalysis", allText);
    return chat({ risks: [{ id: "R-001", description: "A payment failure may leave a transfer in an uncertain state.", category: "Operational", likelihood: "Medium", impact: "High", severity: "High", mitigation: "Define idempotent retry and reconciliation behavior.", residualRisk: "Medium", relatedRequirementIds: ["FR-001"], confidence: 0.8 }] });
  }
  if (system.includes("SDLC-Selection Agent")) {
    appendLog("sdlcSelection", allText);
    const ids = retrievedIds(system);
    const models = ["Agile", "DevSecOps", "Spiral", "V-Model", "Waterfall", "Hybrid"];
    return chat({
      recommendedModel: "Hybrid Agile-DevSecOps",
      recommendationRationale: "Iterative delivery with continuous security checks and explicit compliance gates balances change and control.",
      candidates: models.map((model, index) => ({ model, score: 90 - index * 6, justification: `Relative fit for the stated project risks and constraints: ${model}.`, pros: ["Clear feedback loop"], cons: ["Requires disciplined governance"], citedEvidenceIds: ids.slice(index, index + 1) })),
      workflow: [{ phase: "Plan", activities: ["Confirm scope and risks"], roles: ["Product owner", "Security lead"], deliverables: ["Prioritised requirements"], validationGate: "Owner review", securityControls: ["Threat review"], complianceCheckpoints: ["Map applicable evidence"] }],
    });
  }
  if (system.includes("Documentation Agent")) {
    appendLog("documentation", allText);
    const requirements = input.requirements || [];
    return chat({
      srs: {
        title: `${input.project?.title || "Project"} — Software Requirements Specification`,
        purpose: "Specify a payment system that can be reviewed and verified.",
        scope: input.project?.description || "Payment transfers.",
        assumptions: [],
        functionalRequirements: requirements.filter((item) => item.type === "functional").map((item) => item.id),
        nonFunctionalRequirements: requirements.filter((item) => item.type === "non-functional").map((item) => item.id),
        useCases: [{ id: "UC-001", name: "Initiate payment", actors: ["Customer"], preconditions: ["Customer is authenticated"], mainFlow: ["Enter payment details", "Confirm payment"], alternateFlows: ["Reject invalid details"], postconditions: ["Payment decision is recorded"], requirementIds: requirements.map((item) => item.id) }],
        userStories: [{ id: "US-001", asA: "customer", iWant: "to make a payment", soThat: "I can transfer funds", acceptanceCriteria: ["Given valid details, when I confirm, then the system records a payment decision"], requirementIds: requirements.map((item) => item.id) }],
        interfaces: ["Payment service API"],
        securityPrivacy: ["Least-privilege access"],
        compliance: ["Applicability requires owner review"],
        operations: ["Monitor transfer completion and reconcile failures"],
        risks: ["R-001"],
        sdlc: { model: input.sdlc?.recommendedModel, rationale: input.sdlc?.recommendationRationale, workflow: input.sdlc?.workflow || [] },
      },
      traceability: requirements.map((item) => ({ requirementId: item.id, source: item.source, evidenceIds: [], srsSection: item.type === "functional" ? "4. Functional requirements" : "5. Non-functional requirements" })),
    });
  }
  if (system.includes("Validation Agent")) {
    appendLog("validation", allText);
    return chat({ issues: [] });
  }
  return chat({});
};
