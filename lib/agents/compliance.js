const { ask, retrieve, evidenceText } = require("./shared");

async function run({ apiKey, model, project, requirements }) {
  const query = `${project.jurisdictions?.join(", ") || "unspecified jurisdiction"}\n${project.description}\n${requirements.map((r) => r.statement).join("\n")}`;
  const evidence = await retrieve({
    apiKey,
    query,
    categories: ["regulation", "policy"],
    jurisdiction: project.jurisdictions?.join(", "),
    topK: 8,
  });
  const result = await ask({
    name: "Compliance Agent",
    apiKey,
    model,
    maxTokens: 3500,
    instructions: `Map requirements only to the retrieved evidence supplied below. Treat illustrative seed records as illustrative, not authoritative law. Cite only exact retrieved IDs. If jurisdiction is absent, source is illustrative, relevance is uncertain, or no support exists, mark status "unverified" and explain the gap rather than presenting a legal conclusion. Output {"mappings":[{"requirementId":"FR-001","obligation":"... or null","jurisdiction":"...","status":"supported|partial|unverified","citedEvidenceIds":["REG-001"],"confidence":0.8,"gap":"..."}]}. Retrieved evidence:\n${evidenceText(evidence)}`,
    input: { project: { title: project.title, jurisdictions: project.jurisdictions }, requirements },
  });
  return { ...result, retrievedEvidence: evidence };
}

module.exports = { run };
