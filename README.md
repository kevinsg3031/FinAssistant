# FinAssistant — Agentic Requirements Engineering for Financial Software

FinAssistant turns a project description and a focused discovery chat into classified functional and non-functional requirements, a Software Requirements Specification (SRS), evidence-linked compliance and security analysis, a risk register, traceability, and a project-specific SDLC recommendation.

The workflow uses 13 modular agent roles. Compliance, security/privacy, and SDLC analysis use retrieval-grounded generation (RAG) over the local knowledge base. The signed-in project owner reviews and records approvals before treating the outputs as validated.

## Requirements

- Node.js 18 or later

## Run it

Install dependencies once:

```sh
npm install
```

Start the application:

```sh
npm start
```

Open the local address printed by the server (by default **http://localhost:3000**) and create an account or sign in. Accounts have separate project workspaces and saved analyses.

## How to use it

1. Enter a project name and describe what you want to build in the **Project brief**.
2. The Stakeholder Interaction Agent asks a small batch of relevant questions together. High-level answers are enough; unknown details can be marked TBD. The Clarification Agent pauses only for material blockers, presenting them together rather than requesting every missing implementation detail.
3. Optionally paste supporting text. Sensitive-looking values are masked before the text is sent for analysis or saved.
4. Run the multi-agent analysis. The stage list is updated as each specialist completes. If clarification is required, answer the questions and resume.
5. Review the results: Inputs & clarifications, Requirements, SRS, Compliance, Security, Risks, Conflicts, SDLC, Traceability, Audit trail, and Knowledge base. The project owner can approve individual requirements and approve the analysis. Requesting changes returns to the saved inputs to add guidance and rerun; the revised completion is saved as a separate analysis so the prior review remains available.
6. Download the SRS as a PDF. Completed analyses are archived automatically and are available from **Saved analyses**.

Reopening or refreshing the app starts with a blank project workspace; unfinished descriptions, chat, sources, and analysis results are discarded. Completed analyses are archived in **Saved analyses**, including the original project brief, supporting text, discovery conversation, and clarification questions with answers alongside the final results.

## Model availability

By default, generation calls try `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite` when a model reports high demand or capacity errors. These model IDs are listed as stable options in [Google's Gemini API model documentation](https://ai.google.dev/gemini-api/docs/models). The model from `GOOGLE_MODEL` is tried first; the rest are attempted immediately in order on capacity failure, without waiting to retry the busy model. If all models are busy, the pool waits briefly with backoff and tries the list again. Set `GOOGLE_MODEL_POOL` to override the list. Model availability and quotas depend on your project. Embeddings use a separate pool configured by `GOOGLE_EMBEDDING_MODEL_POOL`. Concurrent provider calls are queued, and capacity retries are bounded so an unavailable provider cannot leave an analysis pending forever.

## Architecture

```text
server.js                         Authenticated HTTP API, model-call boundary, PDF export
lib/coordinator.js                Ordered 11-stage analysis, handoffs, clarification gate, audit hashes
lib/agents/index.js                Registry for the modular specialist agent roles
lib/agents/*.js                    One focused module per agent role
lib/agents/shared.js               Common model prompt framing and RAG helpers
lib/kb.js                          Knowledge-base loading, embedding cache, filters, cosine retrieval
lib/complianceRules.js             Deterministic compliance evidence and jurisdiction checks
lib/storage.js                     Account-scoped SQLite workspaces, archives, approval records
lib/masking.js                     Server-side masking for sensitive-looking input
data/knowledge-base.json           Versioned evidence records; see docs/knowledge-base.md
data/.kb-embeddings-cache.json     Automatically created retrieval embedding cache
data/finreq.sqlite                 Automatically created account and project database
public/index.html                  Application shell and authentication UI
public/app.js                      Project chat, progress, results, review, archive, and download UI
docs/                              RAG, agent communication, schemas, SDLC, and data handling
```

The Coordinator and Human-Approval roles are deterministic modules rather than separate model calls. The Stakeholder Interaction Agent responds once per chat turn. Each analysis specialist receives only the data needed for its stage; retrieval-dependent agents receive evidence selected before generation. See [docs/agent-architecture.md](docs/agent-architecture.md), [docs/rag-workflow.md](docs/rag-workflow.md), and [docs/assurance-and-research.md](docs/assurance-and-research.md) for the implementation details and research considerations.

## Knowledge-base note

The included 37-record knowledge base is an illustrative demonstration set, not authoritative regulatory text or legal advice. Citations show which local records were retrieved; jurisdiction filters and deterministic checks prevent unsupported or illustrative evidence from being presented as verified legal applicability. Replace the seed records with approved, maintained organizational sources before relying on the system.

## Tests

```sh
npm run test:unit
npm run test:e2e
```

The browser suite uses a deterministic model mock, not live model responses. Install the Playwright browser once before running it:

```sh
npx playwright install chromium
```
