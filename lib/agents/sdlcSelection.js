const { ask, retrieve, evidenceText } = require("./shared");

async function run({ apiKey, model, project, requirements, risks }) {
  const evidence = await retrieve({
    apiKey,
    query: `Select and justify SDLC for a project with these characteristics:\n${project.description}\n${requirements.map((r) => r.statement).join("\n")}\nRisks: ${risks.map((r) => r.description).join("\n")}`,
    categories: ["sdlc-rule"],
    topK: 8,
  });
  const result = await ask({
    name: "SDLC-Selection Agent",
    apiKey,
    model,
    maxTokens: 3500,
    instructions: `Compare Agile, DevSecOps, Spiral, V-Model, Waterfall, and hybrid approaches using the project's expected change frequency, regulatory criticality, uncertainty, dependencies, and risks. Provide 0-100 relative suitability scores that need not sum to 100. Justify the recommendation versus each alternative using project characteristics and cite only the retrieved SDLC rules. State evidence gaps. Create a tailored workflow with phases, activities, roles, deliverables, validation gates, security controls, and compliance checkpoints. Output {"recommendedModel":"...","recommendationRationale":"...","candidates":[{"model":"Agile","score":80,"justification":"...","pros":["..."],"cons":["..."],"citedEvidenceIds":[]}],"workflow":[{"phase":"...","activities":["..."],"roles":["..."],"deliverables":["..."],"validationGate":"...","securityControls":["..."],"complianceCheckpoints":["..."]}]}. Retrieved evidence:\n${evidenceText(evidence)}`,
    input: { project, requirements, risks },
  });
  return { ...result, retrievedEvidence: evidence };
}

module.exports = { run };
