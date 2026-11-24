# Agent architecture

This matches the architecture in the brief: a coordinator, a conversational interaction agent, and a chain of specialist agents, each a distinct call with its own narrow prompt — not one mega-prompt pretending to be all of them.

| Agent (from the brief) | Implemented as | Endpoint |
|---|---|---|
| Coordinator agent | `server.js` itself — no LLM call. It sequences every stage below, carries the running context (requirements, compliance, risks…) between them, and enforces the two gates (clarification, human review). | — |
| Stakeholder interaction agent | A genuine multi-turn conversation. One call per turn; the agent asks one question, judges the answer, and decides to follow up or move on. | `POST /api/interview/turn` |
| Requirement extraction agent | Reads every interview transcript and input source, extracts plain candidate requirement statements — nothing classified yet. | `POST /api/pipeline/extract` |
| Clarification agent | Reviews the extracted list and flags anything incomplete or ambiguous with a specific question. If anything is flagged, the Coordinator pauses here until you answer. | `POST /api/pipeline/clarify-check` |
| Classification agent + Conflict-detection agent | Run together in one call: assigns IDs, categories and priority, and separately flags contradictions/duplicates across the set. | `POST /api/pipeline/classify` |
| Compliance agent + Security & privacy agent | Run together, **retrieval-grounded**: for each requirement, the server retrieves relevant knowledge-base evidence first, then the agent may only cite what was retrieved (see `rag-workflow.md`). | `POST /api/pipeline/compliance` |
| Risk-analysis agent | Assesses business, technical and compliance risk, weighting anything with a compliance gap or low confidence more heavily. | `POST /api/pipeline/risk` |
| SDLC-selection agent | Also retrieval-grounded, against the knowledge base's `sdlc-rule` items. Scores 6 candidate models and cites which rule justified each score. | `POST /api/pipeline/sdlc` |
| Documentation agent + Validation agent | Run together: assembles the traceability matrix, and separately validates the whole set — anything missing a compliance mapping, below a confidence threshold, or caught in a conflict is marked `needsReview`. | `POST /api/pipeline/document` |
| Human-approval agent | Two mechanisms: automatic escalation (the "Escalated" badge, driven by Validation's `needsReview`) and manual Approve/Flag controls on every requirement. Neither is decorative — escalation is driven by real confidence scores from the Compliance agent. | (client-side UI) |

## Why granular, client-orchestrated calls instead of one pipeline call

Each stage is its own stateless HTTP endpoint, and the **client** drives the sequence — awaiting one call before starting the next — rather than the server running all seven stages inside a single request. Two reasons:

1. **Real progress, not a fake one.** The stage list you see in the UI reflects calls that have actually returned, not a timed animation guessing how long a black-box call might take.
2. **A real pause point.** When the Clarification agent flags something, the Coordinator can genuinely stop and wait for you to answer, then resume from exactly where it left off — because "waiting for the next stage" is just "the client hasn't made the next call yet," not a server-side session that could go stale.

## What's a deliberate simplification here

- The Stakeholder Interaction agent's "judgement" of vague/incomplete/inconsistent answers is the model's own reasoning per turn, not a separate rule engine — reasonable for a demo, but a production build might add a lightweight deterministic check (e.g. flag answers under N words) as a cheap first pass before the LLM judgement.
- Classification+Conflict-detection and Documentation+Validation are each combined into one call for cost, rather than four separate calls. The brief's table treats them as distinct agents; here they're distinct *responsibilities* fulfilled by two calls with a single combined prompt each.
- Users can explicitly archive completed analyses with their interview/source inputs and results, but there is no persistent audit log of every individual agent call across sessions.
