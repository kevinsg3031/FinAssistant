# FinAssistant — Local Edition (Agentic / RAG)

Agentic requirement gathering, retrieval-grounded compliance mapping, and SDLC advice for financial software — running entirely on your own machine.

Choose a use case first, then select stakeholder roles and conduct interviews. FinAssistant runs a chain of specialist agents — extraction, clarification, classification, compliance (grounded in a local knowledge base), risk, SDLC selection, documentation and validation — pausing for your input if anything's ambiguous, and flagging anything low-confidence for your review at the end.

## Requirements
- **Node.js 18 or later**

## Run it
Install dependencies once:
```
cd finreq-local
npm install
```
Start the app:
```
npm start
```
Open **http://localhost:3001** and create an account with a username or sign in using your username (email sign-in remains supported). Each account has its own private workspace, interviews and saved analyses.

## How to use it
1. Choose a use case and review its preview, then click **Continue with this use case**. Use **Back to use cases** on the next step if you want to change it.
2. Pick a stakeholder role and click **Start interview** — a chat opens. Type answers as that stakeholder; the agent asks follow-ups when an answer is vague or incomplete, and tells you when it has enough. Click **Save interview**, then repeat for other roles if you like (or add pasted documents under **Additional input sources** — sensitive fields are masked automatically). A normal browser refresh restores the current step and its work; opening the app URL as a fresh navigation starts at use-case selection. Switching use cases discards unanalysed drafts.
3. Click **Run multi-agent analysis**. Watch the stage list — each row is a real, separate agent call completing in sequence. If the Clarification agent flags anything, the pipeline pauses and asks you directly; answer and click **Continue analysis**. A fully completed analysis, including its inputs, is archived automatically. If a run fails or is abandoned, its draft interviews and sources are discarded.
4. Review results across seven tabs: Requirements (with confidence scores and auto-escalated items), Compliance (with citation chips linking to the knowledge base), Risk register, Conflicts, SDLC recommendation (six scored candidates, cited, with pros/cons), Traceability, and a browsable Knowledge base.

## Architecture

```
server.js                       Coordinator: static file server + one stateless route per agent
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

## Tests
```
node tests/unit.js     # retrieval math + knowledge-base integrity
node tests/persistence.js # SQLite, account-scoped workspace and analysis tests
node tests/auth.js    # authentication, sessions and API access isolation
node tests/e2e.js      # drives the real UI + server end to end with Google AI mocked (needs: npm i -D playwright)
```
The end-to-end test runs the full chain — adaptive interview, masking, the clarification gate, all seven agents, citations, escalation, the KB browser — against a deterministic fake Google AI API (`tests/mock-google.js`), and asserts from the mock's call log that retrieval really fed the Clarification, Compliance, SDLC and Documentation agents with knowledge-base evidence. The mock is a test harness only; it is never used when you run the app normally.
