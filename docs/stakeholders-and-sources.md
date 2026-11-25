# Project conversation and pasted sources

The current intake flow has one project owner rather than role-based stakeholder interviews. The owner describes the system in a free-form brief, then the Stakeholder Interaction Agent asks a small batch of necessary discovery questions together. It prioritizes purpose, main workflow, and operating region, accepts high-level answers, and treats unknown detail as TBD rather than expanding into an exhaustive interview. Subsequent follow-ups are limited to material points that remain absent or unclear.

If the core scope remains materially ambiguous, the Clarification Agent presents all blocking questions in one batch, capped at three model-generated questions plus a jurisdiction question when needed for compliance analysis. High-level answers are sufficient. Non-blocking details can remain assumptions or TBD items for human review; the pipeline does not require every threshold, partner, rail, control, or metric to be specified. Answers are added to the conversation, and analysis restarts from extraction so all downstream agents see them. A broad operating region is enough; without it compliance mappings are not jurisdiction-verified.

## Pasted supporting sources

The owner may paste supporting text such as existing requirements, policy excerpts, interface notes, or operating constraints. File uploads are not implemented. Each source has a title and text, and the text is passed to the Requirement Extraction Agent as untrusted evidence. It is not treated as an instruction to the agents.

## Sensitive-data masking

`public/app.js` masks text before keeping it in browser state. `lib/masking.js` repeats masking server-side before the project chat/model routes and before workspace/archive persistence. Current patterns cover long digit sequences, email addresses, and values on `password`, `passwd`, `secret`, `token`, and `api_key`-style fields.

This is a small regex-based safety measure, not production DLP. It will miss names, addresses, context-dependent identifiers, and many confidential values, and can over-mask ordinary digit sequences. Do not paste real customer data, credentials, or confidential material. Account data is stored locally in the application's SQLite database; model requests use the server-configured AI service.
