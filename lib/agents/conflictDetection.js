const { ask } = require("./shared");

async function run({ apiKey, model, requirements }) {
  return ask({
    name: "Conflict-Detection Agent",
    apiKey,
    model,
    maxTokens: 2200,
    instructions: `Compare the complete requirement set for direct contradictions, incompatible targets, duplicate intent, and meaningful dependencies. Report only evidence-supported pairs and distinguish conflict, duplicate, and dependency. Do not resolve a conflict by choosing one requirement. Output {"findings":[{"kind":"conflict|duplicate|dependency","requirementIds":["FR-001","NFR-001"],"description":"...","evidence":"short exact phrases"}]}. Return an empty findings array if none exist.`,
    input: { requirements },
  });
}

module.exports = { run };
