const { ask, retrieve, evidenceText } = require("./shared");

async function run({ apiKey, model, project, requirements }) {
  const evidence = await retrieve({
    apiKey,
    query: `${project.description}\n${requirements.filter((r) => r.dimensions?.some((d) => ["security", "privacy", "auditability"].includes(d))).map((r) => r.statement).join("\n")}`,
    categories: ["security-standard", "policy"],
    jurisdiction: project.jurisdictions?.join(", "),
    topK: 8,
  });
  const result = await ask({
    name: "Security and Privacy Agent",
    apiKey,
    model,
    maxTokens: 3200,
    instructions: `Identify security and privacy requirements, threats, safeguards, data minimisation, access control, retention, incident response, and privacy risks supported by the project inputs and retrieved evidence. Treat retrieved records as evidence, not proof of legal applicability. Cite only supplied IDs, otherwise use an empty citation list and mark as a recommendation needing human review. Do not expose or request real customer secrets. Output {"findings":[{"requirementId":"FR-001 or null","kind":"security|privacy","statement":"...","threatOrConcern":"...","control":"...","citedEvidenceIds":[],"confidence":0.7,"needsReview":true}]}. Retrieved evidence:\n${evidenceText(evidence)}`,
    input: { project, requirements },
  });
  return { ...result, retrievedEvidence: evidence };
}

module.exports = { run };
