const crypto = require("crypto");
const agents = require("./agents/index");
const { applyComplianceRules } = require("./complianceRules");
const { normalizeDocumentation } = require("./documentation");

const STAGES = [
  { key: "extract", label: "Requirement extraction", agent: "Requirement Extraction Agent" },
  { key: "clarify", label: "Clarification check", agent: "Clarification Agent" },
  { key: "classify", label: "Requirement classification", agent: "Classification Agent" },
  { key: "conflicts", label: "Conflict and duplication analysis", agent: "Conflict-Detection Agent" },
  { key: "compliance", label: "Compliance mapping (RAG)", agent: "Compliance Agent" },
  { key: "security", label: "Security and privacy review (RAG)", agent: "Security and Privacy Agent" },
  { key: "risk", label: "Risk analysis", agent: "Risk-Analysis Agent" },
  { key: "sdlc", label: "SDLC selection (RAG)", agent: "SDLC-Selection Agent" },
  { key: "documentation", label: "SRS and traceability", agent: "Documentation Agent" },
  { key: "validation", label: "Consistency and evidence validation", agent: "Validation Agent" },
  { key: "approval", label: "Owner approval checkpoint", agent: "Human-Approval Agent" },
];

const AGENT_CATALOG = [
  { name: "Coordinator Agent", module: "lib/coordinator.js", responsibility: "Sequences agents, validates handoffs, maintains context, streams progress, and enforces gates." },
  { name: "Stakeholder Interaction Agent", module: "lib/agents/stakeholderInteraction.js", responsibility: "Runs the single project-description chat and asks one adaptive question per turn." },
  { name: "Requirement Extraction Agent", module: "lib/agents/requirementExtraction.js", responsibility: "Extracts atomic requirements and provenance from the project conversation and pasted sources." },
  { name: "Clarification Agent", module: "lib/agents/clarification.js", responsibility: "Identifies blocking ambiguity, missing measurable criteria, and missing jurisdiction; pauses analysis for answers." },
  { name: "Classification Agent", module: "lib/agents/classification.js", responsibility: "Separates functional and non-functional requirements, dimensions, priority, IDs, and confidence." },
  { name: "Conflict-Detection Agent", module: "lib/agents/conflictDetection.js", responsibility: "Finds contradictions, duplicate intent, and dependencies across classified requirements." },
  { name: "Compliance Agent", module: "lib/agents/compliance.js", responsibility: "Maps requirements only to jurisdiction-filtered retrieved compliance and policy evidence." },
  { name: "Security and Privacy Agent", module: "lib/agents/securityPrivacy.js", responsibility: "Assesses security and privacy concerns against project context and retrieved evidence." },
  { name: "Risk-Analysis Agent", module: "lib/agents/riskAnalysis.js", responsibility: "Scores business, technical, security, privacy, compliance, delivery, and operational risks." },
  { name: "SDLC-Selection Agent", module: "lib/agents/sdlcSelection.js", responsibility: "Compares lifecycle models and designs a justified project-specific workflow using retrieved rules." },
  { name: "Documentation Agent", module: "lib/agents/documentation.js", responsibility: "Produces SRS sections, user stories, use cases, acceptance criteria, and traceability." },
  { name: "Validation Agent", module: "lib/agents/validation.js", responsibility: "Combines model review with deterministic reference, citation, coverage, and consistency checks." },
  { name: "Human-Approval Agent", module: "lib/agents/humanApproval.js", responsibility: "Creates pending owner-review tasks for every requirement and routes high-risk/evidence gaps to review." },
];

function stableId(requirement, index) {
  const prefix = requirement.type === "non-functional" ? "NFR" : "FR";
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function normalizedRequirements(extracted, classified) {
  const sourceByTempId = new Map((extracted.requirements || []).map((item) => [item.tempId, item]));
  const counts = { functional: 0, "non-functional": 0 };
  return (classified.requirements || []).map((item, index) => {
    const source = sourceByTempId.get(item.tempId) || {};
    const type = item.type === "non-functional" ? "non-functional" : "functional";
    counts[type] += 1;
    return {
      ...source,
      ...item,
      id: stableId({ ...item, type }, counts[type] - 1),
      type,
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
      dimensions: Array.isArray(item.dimensions) ? item.dimensions : [],
      source: item.source || source.source || "Project conversation",
      sourceExcerpt: item.sourceExcerpt || source.sourceExcerpt || "",
    };
  });
}

function evidenceForResult(value) {
  return Array.isArray(value?.retrievedEvidence) ? value.retrievedEvidence : [];
}

function requireArray(output, field, agent) {
  if (!Array.isArray(output?.[field])) throw new Error(`${agent} returned an invalid response: "${field}" must be an array.`);
  return output[field];
}

function resolveEvidence(records, evidenceByAgent) {
  const evidence = new Map(Object.values(evidenceByAgent).flat().map((item) => [item.id, item]));
  return (records || []).map((record) => ({
    ...record,
    evidence: (record.citedEvidenceIds || []).map((id) => evidence.get(id)).filter(Boolean),
  }));
}

async function runAnalysis({ apiKey, model, project, conversation, sources = [], onStage = async () => {} }) {
  const auditTrail = [];
  const evidenceByAgent = {};

  async function execute(key, operation) {
    const stage = STAGES.find((item) => item.key === key);
    await onStage({ key, label: stage.label, status: "active", agent: stage.agent });
    const startedAt = new Date().toISOString();
    const output = await operation();
    const outputHash = crypto.createHash("sha256").update(JSON.stringify(output)).digest("hex");
    const citations = [
      ...((output.mappings || []).flatMap((record) => record.citedEvidenceIds || [])),
      ...((output.findings || []).flatMap((record) => record.citedEvidenceIds || [])),
      ...((output.candidates || []).flatMap((record) => record.citedEvidenceIds || [])),
      ...((output.traceability || []).flatMap((record) => record.evidenceIds || [])),
    ];
    auditTrail.push({ agent: stage.agent, stage: key, startedAt, completedAt: new Date().toISOString(), outputSha256: outputHash, evidenceIds: [...new Set(citations)] });
    await onStage({ key, label: stage.label, status: "done", agent: stage.agent });
    return output;
  }

  const extracted = await execute("extract", () => agents.requirementExtraction.run({ apiKey, model, project, conversation, sources }));
  const extractedRequirements = requireArray(extracted, "requirements", "Requirement Extraction Agent");
  if (extractedRequirements.length === 0) {
    throw new Error("No supported requirements could be extracted. Add a clearer project description and try again.");
  }

  const clarification = await execute("clarify", () => agents.clarification.run({ apiKey, model, project, conversation, requirements: extractedRequirements }));
  const clarificationQuestions = requireArray(clarification, "questions", "Clarification Agent");
  if (project.jurisdictions?.length && project.jurisdictions.some((item) => typeof item !== "string")) {
    throw new Error("Jurisdictions must be a list of text values.");
  }
  if (clarification.ready === false && clarificationQuestions.length === 0) {
    throw new Error("Clarification Agent reported blocking gaps without returning questions.");
  }
  const jurisdictionQuestion = !project.jurisdictions?.length
    ? [{ id: "JURISDICTION", requirementRef: "project", question: "Which countries or regions will this system operate in? Regulatory applicability cannot be assessed without this scope.", reason: "Compliance mapping must be jurisdiction-specific." }]
    : [];
  const remainingQuestions = clarificationQuestions.filter((item) =>
    project.jurisdictions?.length || !/jurisdiction|country|countries|region/i.test(`${item.question || ""} ${item.reason || ""}`));
  const questions = [
    ...jurisdictionQuestion,
    ...(clarification.ready === false ? remainingQuestions : []),
  ].slice(0, 4);
  if (questions.length) {
    await onStage({ key: "clarify", label: "Clarification check", status: "waiting", agent: "Clarification Agent" });
    return { needsClarification: true, questions, extractedRequirements, auditTrail, complete: false };
  }

  const classified = await execute("classify", () => agents.classification.run({ apiKey, model, requirements: extractedRequirements }));
  const classifiedRequirements = requireArray(classified, "requirements", "Classification Agent");
  if (classifiedRequirements.length !== extractedRequirements.length) {
    throw new Error("Classification Agent did not return every extracted requirement.");
  }
  if (classifiedRequirements.some((item) => !["functional", "non-functional"].includes(item.type) || typeof item.statement !== "string")) {
    throw new Error("Classification Agent returned a requirement without a valid type or statement.");
  }
  const requirements = normalizedRequirements(extracted, classified);
  if (!requirements.length) throw new Error("Classification returned no requirements.");

  const conflicts = await execute("conflicts", () => agents.conflictDetection.run({ apiKey, model, requirements }));
  const conflictFindings = requireArray(conflicts, "findings", "Conflict-Detection Agent");
  const complianceRaw = await execute("compliance", () => agents.compliance.run({ apiKey, model, project, requirements }));
  const complianceMappings = requireArray(complianceRaw, "mappings", "Compliance Agent");
  evidenceByAgent.compliance = evidenceForResult(complianceRaw);
  const complianceRules = applyComplianceRules(complianceMappings, {
    jurisdictions: project.jurisdictions || [],
    retrievedEvidence: evidenceByAgent.compliance,
    requirementIds: requirements.map((item) => item.id),
  });
  const securityRaw = await execute("security", () => agents.securityPrivacy.run({ apiKey, model, project, requirements }));
  requireArray(securityRaw, "findings", "Security and Privacy Agent");
  evidenceByAgent.security = evidenceForResult(securityRaw);
  const compliance = { ...complianceRaw, mappings: resolveEvidence(complianceRules.mappings, evidenceByAgent), ruleIssues: complianceRules.issues };
  const security = { ...securityRaw, findings: resolveEvidence(securityRaw.findings, evidenceByAgent) };
  const risk = await execute("risk", () => agents.riskAnalysis.run({ apiKey, model, project, requirements, conflicts, compliance, security }));
  const risks = requireArray(risk, "risks", "Risk-Analysis Agent");
  const sdlcRaw = await execute("sdlc", () => agents.sdlcSelection.run({ apiKey, model, project, requirements, risks }));
  const candidates = requireArray(sdlcRaw, "candidates", "SDLC-Selection Agent");
  const workflow = requireArray(sdlcRaw, "workflow", "SDLC-Selection Agent");
  if (typeof sdlcRaw.recommendedModel !== "string" || !sdlcRaw.recommendedModel.trim()) {
    throw new Error("SDLC-Selection Agent did not recommend a lifecycle model.");
  }
  evidenceByAgent.sdlc = evidenceForResult(sdlcRaw);
  const sdlc = {
    ...sdlcRaw,
    candidates: resolveEvidence(candidates, evidenceByAgent),
    workflow,
    citedEvidenceIds: [...new Set(candidates.flatMap((item) => item.citedEvidenceIds || []))],
  };
  const docsRaw = await execute("documentation", async () => {
    const output = await agents.documentation.run({ apiKey, model, project, requirements, conflicts, compliance, security, risks, sdlc });
    return normalizeDocumentation(output, { project, requirements, security, compliance, risks, sdlc });
  });
  evidenceByAgent.documentation = evidenceForResult(docsRaw);
  const traceability = docsRaw.traceability;
  const validation = await execute("validation", () => agents.validation.run({
    apiKey, model, project, requirements, conflicts: conflictFindings, compliance, security,
    risks, srs: docsRaw.srs, traceability, evidenceByAgent, sdlc,
  }));
  requireArray(validation, "issues", "Validation Agent");
  const approvalTasks = await execute("approval", async () => agents.humanApproval.createApprovalTasks({ requirements, validation, compliance, conflicts: conflictFindings }));
  if (!Array.isArray(approvalTasks)) throw new Error("Human-Approval Agent returned invalid approval tasks.");
  const allEvidence = [...new Map(Object.values(evidenceByAgent).flat().map((item) => [item.id, item])).values()];

  return {
    project,
    requirements,
    conflicts: conflictFindings,
    compliance: compliance.mappings || [],
    security: security.findings || [],
    risks,
    sdlc,
    srs: docsRaw.srs || {},
    traceability,
    validation,
    approvalTasks,
    evidence: allEvidence,
    evidenceByAgent,
    auditTrail,
    complete: true,
    createdAt: new Date().toISOString(),
  };
}

module.exports = { STAGES, AGENT_CATALOG, runAnalysis, normalizeDocumentation };
