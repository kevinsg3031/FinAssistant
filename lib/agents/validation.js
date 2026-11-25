const { ask } = require("./shared");

function validateCitations(records, evidence) {
  const allowed = new Set((evidence || []).map((item) => item.id));
  const violations = [];
  for (const record of records) {
    for (const id of record.citedEvidenceIds || []) {
      if (!allowed.has(id)) violations.push({ item: record.requirementId || record.statement, citation: id, reason: "Citation was not in retrieved evidence." });
    }
  }
  return violations;
}

async function run({ apiKey, model, project, requirements, conflicts, compliance, security, risks, srs, traceability, evidenceByAgent, sdlc }) {
  const modelCheck = await ask({
    name: "Validation Agent",
    apiKey,
    model,
    maxTokens: 2500,
    instructions: `Review completeness, consistency, testability, source traceability, requirement-ID references, SRS coverage, unsupported assumptions, and whether risks/conflicts/compliance gaps are visibly surfaced. Do not decide legal applicability. Return only actionable issues. Output {"issues":[{"severity":"critical|high|medium|low","item":"FR-001 or SRS","description":"...","recommendation":"..."}]}.`,
    input: { project, requirements, conflicts, compliance, security, risks, srs, traceability, sdlc },
  });
  const citationViolations = [
    ...validateCitations(compliance.mappings || [], evidenceByAgent.compliance || []),
    ...validateCitations(security.findings || [], evidenceByAgent.security || []),
    ...validateCitations(sdlc?.candidates || [], evidenceByAgent.sdlc || []),
    ...validateCitations((traceability || []).map((item) => ({ ...item, citedEvidenceIds: item.evidenceIds || [] })), evidenceByAgent.documentation || []),
  ];
  const knownIds = new Set(requirements.map((requirement) => requirement.id));
  const brokenTraceability = traceability.filter((item) => !knownIds.has(item.requirementId));
  const deterministicIssues = [
    ...(compliance.ruleIssues || []),
    ...citationViolations.map((item) => ({ severity: "high", item: item.item, description: item.reason, recommendation: `Remove or retrieve citation ${item.citation} before relying on this mapping.` })),
    ...brokenTraceability.map((item) => ({ severity: "high", item: item.requirementId, description: "Traceability points to an unknown requirement ID.", recommendation: "Correct the requirement reference." })),
    ...requirements.filter((requirement) => !traceability.some((item) => item.requirementId === requirement.id)).map((item) => ({ severity: "medium", item: item.id, description: "Requirement has no traceability record.", recommendation: "Add source and SRS section traceability." })),
    ...requirements.filter((requirement) => !requirement.statement || requirement.statement.length < 15).map((item) => ({ severity: "medium", item: item.id, description: "Requirement statement may not be sufficiently specific to verify.", recommendation: "Clarify the expected behavior and acceptance measure." })),
  ];
  return { issues: [...(modelCheck.issues || []), ...deterministicIssues], citationViolations, ruleChecksPassed: citationViolations.length === 0 && brokenTraceability.length === 0 };
}

module.exports = { run, validateCitations };
