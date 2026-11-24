# FinAssistant — Local Edition (Agentic / RAG)

Agentic requirement gathering, retrieval-grounded compliance mapping, and SDLC advice for financial software — running entirely on your own machine, calling the Google AI Studio Gemini API with your own key.

Choose a use case first, then select stakeholder roles and conduct interviews. FinAssistant runs a chain of specialist agents — extraction, clarification, classification, compliance (grounded in a local knowledge base), risk, SDLC selection, documentation and validation — pausing for your input if anything's ambiguous, and flagging anything low-confidence for your review at the end.

## Requirements
- **Node.js 18 or later**
- **A Google AI Studio API key** — get one at https://aistudio.google.com/apikey. API usage is subject to Google's quotas and billing terms for your project.

## Run it
```
cd finreq-local
cp .env.example .env
npm install
```
Open `.env` and paste your Google AI Studio key in:
```
GOOGLE_API_KEY=...
```
Then:
```
node server.js
```
Open **http://localhost:3000** and create an account with a username or sign in using your username (email sign-in remains supported). Each account has its own private workspace, interviews and saved analyses. The key lives only in `.env`, read once by the Node process at startup — there's no key field anywhere in the UI, and the browser never sees it.

## How to use it
1. Choose a use case and review its preview, then click **Continue with this use case**. Use **Back to use cases** on the next step if you want to change it.
2. Pick a stakeholder role and click **Start interview** — a chat opens. Type answers as that stakeholder; the agent asks follow-ups when an answer is vague or incomplete, and tells you when it has enough. Click **Save interview**, then repeat for other roles if you like (or add pasted documents under **Additional input sources** — sensitive fields are masked automatically). A normal browser refresh restores the current step and its work; opening the app URL as a fresh navigation starts at use-case selection. Switching use cases discards unanalysed drafts.
3. Click **Run multi-agent analysis**. Watch the stage list — each row is a real, separate agent call completing in sequence. If the Clarification agent flags anything, the pipeline pauses and asks you directly; answer and click **Continue analysis**. A fully completed analysis, including its inputs, is archived automatically. If a run fails or is abandoned, its draft interviews and sources are discarded.
4. Review results across seven tabs: Requirements (with confidence scores and auto-escalated items), Compliance (with citation chips linking to the knowledge base), Risk register, Conflicts, SDLC recommendation (six scored candidates, cited, with pros/cons), Traceability, and a browsable Knowledge base.

## Changing the model
Defaults to `gemini-3.8-flash`. Override in `.env` or on the command line:
```
GOOGLE_MODEL=gemini-3.8-flash node server.js
```
Embeddings (used for retrieval) default to `gemini-embedding-001`; override with `GOOGLE_EMBEDDING_MODEL`.

## Architecture

```
server.js                       Coordinator: static file server + one stateless route per agent
lib/google.js                   Thin fetch wrapper for Gemini generateContent + embeddings
lib/kb.js                       Knowledge-base loading, embedding cache, retrieval (RAG)
lib/agents.js                   One function per agent: prompts + the call itself
data/knowledge-base.json        Versioned, sourced knowledge base (see docs/knowledge-base.md)
data/.kb-embeddings-cache.json  Auto-created: cached embeddings, keyed by content hash
data/finreq.sqlite              Auto-created SQLite database: accounts, sessions, per-user workspaces + saved analyses
public/index.html               The entire frontend: chat interviews, pipeline UI, results
docs/                           agent-architecture · rag-workflow · knowledge-base ·
                                 pipeline-schemas · sdlc-selection-matrix · stakeholders-and-sources
```

Full detail on each piece is in `docs/`, in particular `docs/agent-architecture.md` (how the 13-agent design from the brief maps onto real endpoints) and `docs/rag-workflow.md` (the retrieval-grounded generation loop).

## What changed from the earlier single-call prototype
- **Conversational, not a form.** The old fixed 3-question-per-role form is gone; `POST /api/interview/turn` runs a real multi-turn conversation.
- **Seven separate agent calls, not one.** Each pipeline stage is its own endpoint, called in sequence by the client, so the UI shows genuine incremental progress rather than a single spinner.
- **A real knowledge base.** `data/knowledge-base.json` — versioned, sourced, jurisdiction-tagged — backs two retrieval-grounded agents (Compliance/Security and SDLC Selection), which can only cite what was actually retrieved for that requirement.
- **Confidence-driven escalation.** Requirements with a low-confidence or missing compliance mapping, or caught in a detected conflict, are automatically marked for human review — on top of, not instead of, manual Approve/Flag.
- **A pause-and-resume clarification gate.** If the Clarification agent flags an ambiguous requirement, the pipeline genuinely stops and asks you, rather than guessing.
- **Account-scoped workspace and completed-analysis archive.** The current use case’s interviews, masked sources and in-progress clarification state are saved to SQLite so a normal browser refresh restores the same step and its work; a fresh URL navigation starts at use-case selection. Unfinished runs can be restarted after a refresh. Switching use cases or a failed run discards unanalysed drafts. Fully completed analyses and their exact inputs are archived automatically; reopen or delete them from the sidebar. Passwords are stored as salted scrypt hashes and authentication uses an HttpOnly, SameSite=Strict browser-session cookie (without a persistent expiry), so sign-in normally ends when the browser session closes. Back up `data/finreq.sqlite` (and its `-wal` file if present) to retain or transfer your work. Set `FINREQ_DB_PATH` to change the database location. Existing workspace/analysis records without an account owner are not shown to newly created accounts.

## Tests
```
node tests/unit.js     # retrieval math + knowledge-base integrity
node tests/persistence.js # SQLite, account-scoped workspace and analysis tests
node tests/auth.js    # authentication, sessions and API access isolation
node tests/e2e.js      # drives the real UI + server end to end with Google AI mocked (needs: npm i -D playwright)
```
The end-to-end test runs the full chain — adaptive interview, masking, the clarification gate, all seven agents, citations, escalation, the KB browser — against a deterministic fake Google AI API (`tests/mock-google.js`), and asserts from the mock's call log that retrieval really fed the Clarification, Compliance, SDLC and Documentation agents with knowledge-base evidence. The mock is a test harness only; it is never used when you run the app normally.

## Honest limitations
- **Verified with a mocked Google AI API, not a live one.** The test suite proves the wiring, gates, retrieval plumbing and UI; it can't prove how well a real model follows the prompts. Expect to tune prompts once you've run it against your own key.
- **Cost and latency are both higher than the old single-call design.** An interview is N calls (roughly one per exchange), and a full pipeline run is 6 more, plus embeddings for retrieval. Model pricing and quotas depend on the Google AI Studio project — see `docs/agent-architecture.md`.
- **Local, self-managed accounts.** Application data is stored in a SQLite database on this machine, not in a remotely backed-up service. Anyone who can reach the app can create an account; deploy behind appropriate network controls if that is not intended. Protect and back up `data/finreq.sqlite`; the app does not provide account recovery or a durable audit service.
- **The knowledge base is an illustrative seed (37 items), not real regulatory text.** See `docs/knowledge-base.md` for what a production knowledge base would need on top of this.
- **Sensitive-data masking is a lightweight regex demo**, not production DLP (see `docs/stakeholders-and-sources.md`).
- **No role-based access control or account recovery.** Accounts separate data, but this local tool does not provide administrator roles, email verification, password reset, or production identity management.
