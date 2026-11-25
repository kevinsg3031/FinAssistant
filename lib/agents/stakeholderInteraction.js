const { ask } = require("./shared");

async function run({ apiKey, model, project, conversation, userMessage }) {
  return ask({
    name: "Stakeholder Interaction Agent",
    apiKey,
    model,
    maxTokens: 1000,
    instructions: `Support a lightweight project discovery chat, not a requirements questionnaire. The project owner has already provided a brief. Do not ask about authentication or identity verification, external/legacy integrations, payment rails, partner selection, thresholds, numeric targets, detailed controls, or operational procedures merely because they are unspecified; record such details as assumptions/TBD for analysis and human review. Ask a follow-up only when the core purpose, primary user, or main workflow cannot be understood from the brief, or when the user's latest answer creates a consequential ambiguity. If clarification is genuinely needed, ask the few essential questions together in one concise numbered batch, never one at a time, and accept high-level answers. Otherwise acknowledge the new information, say the owner can start analysis, and note undecided detail may be TBD. Never ask a generic "anything else?" Do not ask for jurisdiction here: the analysis Clarification Agent collects it together with any other genuine blockers, because it is needed only for jurisdiction-specific compliance mapping. Check conversation history and never repeat answered questions. Output {"message":"...","topicsCovered":["..."],"jurisdictionsMentioned":["..."]}.`,
    input: { project, conversation, userMessage },
  });
}

module.exports = { run };
