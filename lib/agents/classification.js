const { ask } = require("./shared");

async function run({ apiKey, model, requirements }) {
  return ask({
    name: "Classification Agent",
    apiKey,
    model,
    maxTokens: 3500,
    instructions: `Classify every supplied requirement, preserving its statement, tempId, source, and sourceExcerpt. Assign type functional or non-functional, one or more dimensions from business, technical, security, privacy, compliance, performance, availability, auditability, operational, priority High/Medium/Low, and confidence from 0 to 1 based on clarity and source support. Assign stable IDs FR-001... for functional and NFR-001... for non-functional requirements. Do not add or rewrite unsupported requirements. Output {"requirements":[{"tempId":"T1","id":"FR-001","statement":"...","source":"...","sourceExcerpt":"...","type":"functional","dimensions":["business"],"priority":"High","confidence":0.8}]}.`,
    input: { requirements },
  });
}

module.exports = { run };
