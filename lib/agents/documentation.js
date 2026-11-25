const { ask, retrieve, evidenceText } = require("./shared");

async function run({ apiKey, model, project, requirements, conflicts, compliance, security, risks, sdlc }) {
  const templates = await retrieve({
    apiKey,
    query: "SRS software requirements specification user stories use cases acceptance criteria traceability",
    categories: ["template", "requirement-guideline"],
    topK: 5,
  });
  const result = await ask({
    name: "Documentation Agent",
    apiKey,
    model,
    maxTokens: 6000,
    instructions: `Generate a structured, concise SRS using the supplied project evidence and the retrieved templates. Include purpose/scope, stakeholders, assumptions, functional and non-functional requirements (reference IDs only), use cases with actors/preconditions/main flow/alternatives, user stories with acceptance criteria, interfaces, security/privacy/compliance, operational constraints, risks, recommended SDLC/workflow, and traceability. Do not introduce requirements absent from the classified set; label unsupported sections as TBD. Link each requirement to source and evidence. Output {"srs":{"title":"...","purpose":"...","scope":"...","assumptions":["..."],"functionalRequirements":["FR-001"],"nonFunctionalRequirements":["NFR-001"],"useCases":[{"id":"UC-001","name":"...","actors":["..."],"preconditions":["..."],"mainFlow":["..."],"alternateFlows":["..."],"postconditions":["..."],"requirementIds":["FR-001"]}],"userStories":[{"id":"US-001","asA":"...","iWant":"...","soThat":"...","acceptanceCriteria":["Given ... When ... Then ..."],"requirementIds":["FR-001"]}],"interfaces":["..."],"securityPrivacy":["..."],"compliance":["..."],"operations":["..."],"risks":["R-001"],"sdlc":{"model":"...","rationale":"...","workflow":[...]}},"traceability":[{"requirementId":"FR-001","source":"...","evidenceIds":[],"srsSection":"..."}]}. Retrieved templates:\n${evidenceText(templates)}`,
    input: { project, requirements, conflicts, compliance, security, risks, sdlc },
  });
  return { ...result, retrievedEvidence: templates };
}

module.exports = { run };
