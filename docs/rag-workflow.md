# Retrieval-grounded generation (RAG)

This implements the workflow from the brief step-for-step, for the two agents that need to ground their output in approved sources: **Compliance & Security** (`/api/pipeline/compliance`) and **SDLC Selection** (`/api/pipeline/sdlc`).

1. **Classify the query.** The query is the candidate requirement's own statement (for compliance/security) or a summary of the requirement/risk profile (for SDLC selection) — no separate classification call is needed since the requirement text itself is the query.
2. **Retrieve relevant evidence.** `lib/kb.js` embeds the query with Google's `gemini-embedding-001`, and ranks it by cosine similarity against the knowledge base — pre-filtered to the categories that agent is allowed to use (`regulation`, `security-standard`, `policy` for compliance; `sdlc-rule` for SDLC selection) and to items whose `applicability` includes the current use case or `"all"`. The top few matches are returned with their id, source, jurisdiction, version and content.
3. **Provide the evidence to the LLM.** The retrieved items are assembled into the prompt as an explicit evidence block, one per requirement (compliance) or one shared block (SDLC selection).
4. **Generate the requirement or analysis.** The agent is instructed that it may only cite what's in the evidence block — if nothing relevant was retrieved, it must say so (`regulation: null`, low confidence, a `gap` note) rather than inventing a plausible-sounding regulation.
5. **Attach citations and confidence scores.** Every compliance mapping and SDLC score carries `citedEvidenceIds`; the server resolves these back to full knowledge-base records (title, source, jurisdiction, version) before sending the response to the UI, where they render as the small `[ID]` chips you can hover over.
6. **Escalate low-confidence or unsupported outputs.** The Validation agent (`/api/pipeline/document`) marks a requirement `needsReview` if its compliance confidence is below 0.6, if no mapping was found at all, or if it appears in the conflict list — these show as an **Escalated** badge in the Requirements tab, on top of (not instead of) the manual Approve/Flag controls.

## Why this reduces hallucination risk (and where it doesn't)

Retrieval happens with real embeddings against real (if illustrative) knowledge-base content — the model cannot cite a knowledge-base ID that wasn't actually retrieved, because the prompt only contains the ids that were. This is a genuine reduction in the *citation* half of the hallucination problem: any `[REG-002]` chip you see really was the evidence handed to the model for that requirement.

What it does **not** solve: the model can still misjudge how well a retrieved item actually supports its conclusion, and the knowledge base itself is a small, illustrative seed (see `knowledge-base.md`) rather than authoritative regulatory text — so "grounded" here means grounded in *this demo's* knowledge base, not grounded in law. Treat every citation as "here's the internal document this came from," and verify it against the real source before relying on it.
