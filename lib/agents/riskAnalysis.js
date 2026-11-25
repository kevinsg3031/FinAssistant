const { ask } = require("./shared");

async function run({ apiKey, model, project, requirements, conflicts, compliance, security }) {
  return ask({
    name: "Risk-Analysis Agent",
    apiKey,
    model,
    maxTokens: 3000,
    instructions: `Assess business, technical, security, privacy, compliance, delivery, and operational risks from the supplied inputs. Explicitly include material conflicts and unverified compliance mappings as risks. Score likelihood and impact Low/Medium/High; derive severity transparently from them. Include mitigations, residual risk, affected requirements, and confidence. Output {"risks":[{"id":"R-001","description":"...","category":"...","likelihood":"Low|Medium|High","impact":"Low|Medium|High","severity":"Low|Medium|High","mitigation":"...","residualRisk":"...","relatedRequirementIds":["FR-001"],"confidence":0.7}]}.`,
    input: { project, requirements, conflicts, compliance, security },
  });
}

module.exports = { run };
