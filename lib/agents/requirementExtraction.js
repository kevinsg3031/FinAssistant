const { ask } = require("./shared");

async function run({ apiKey, model, project, conversation, sources }) {
  return ask({
    name: "Requirement Extraction Agent",
    apiKey,
    model,
    maxTokens: 4500,
    instructions: `Extract atomic, testable candidate requirements supported by the project description, conversation, and pasted source documents. Preserve provenance for every item. Separate functional and non-functional candidates where apparent but do not make unsupported assumptions. Identify unresolved assumptions explicitly. Do not invent facts to meet a target count. Output {"requirements":[{"tempId":"T1","statement":"The system shall ...","source":"conversation|source title","sourceExcerpt":"short supporting excerpt","dimension":"business|technical|security|privacy|compliance|performance|availability|auditability|operational","type":"functional|non-functional","assumptions":[]}],"assumptions":[{"statement":"...","source":"..."}]}.`,
    input: { project, conversation, sources },
  });
}

module.exports = { run };
