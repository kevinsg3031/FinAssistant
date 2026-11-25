const { ask } = require("./shared");

async function run({ apiKey, model, project, conversation, requirements, priorAnswers = [] }) {
  return ask({
    name: "Clarification Agent",
    apiKey,
    model,
    maxTokens: 1800,
    instructions: `Ask only about missing or unclear information that materially prevents a first-pass analysis of the core system or could change its fundamental scope. This is not a completeness audit: do not ask for exact limits, partner/rail names, numeric performance targets, detailed security controls, retention periods, exception catalogs, or other implementation detail unless it is essential to resolve a consequential ambiguity. High-level answers are enough; treat reasonable unknowns as assumptions or TBD items and let downstream agents identify them for review. Ask every genuinely blocking question together in one batch, with no more than three concise, answerable questions. Combine related topics. Respect the conversation and prior answers; never repeat or rephrase an answered question. Ask for jurisdiction only when needed to scope the requested compliance analysis and not already stated; a broad country/region answer is sufficient. Output {"questions":[{"id":"Q1","requirementRef":"T1 or project","question":"...","reason":"briefly explain why this is a blocker"}],"ready":true|false}. Set ready=false only if the questions are actual blockers. If missing detail can be recorded as an assumption, marked TBD, or handled with human review, do not block analysis for it; return ready=true and an empty questions array.`,
    input: { project, conversation, requirements, priorAnswers },
  });
}

module.exports = { run };
