# Agent architecture and communication

FinAssistant implements 13 distinct agent roles as small JavaScript modules. The Coordinator and Human-Approval roles are deterministic code; the other 11 roles use separate, narrowly scoped model calls. The Stakeholder Interaction call runs once per chat turn, before analysis begins.

## Agent inventory

| # | Role | Implementation | Input and output |
|---|---|---|---|
| 1 | Coordinator | `lib/coordinator.js` | Runs the ordered pipeline, passes typed JSON context between agents, emits stage events, and enforces the clarification gate. |
| 2 | Stakeholder Interaction | `lib/agents/stakeholderInteraction.js` | Receives the project brief and chat history; returns one context-aware question or response and detected jurisdiction mentions. Route: `POST /api/project/turn`. |
| 3 | Requirement Extraction | `lib/agents/requirementExtraction.js` | Reads the brief, complete project conversation, and masked pasted sources; returns atomic candidate requirements with source excerpts and assumptions. |
| 4 | Clarification | `lib/agents/clarification.js` | Reads candidates, the conversation, and project scope; returns blocking questions. The Coordinator also asks for jurisdiction when it is absent. |
| 5 | Classification | `lib/agents/classification.js` | Assigns functional/non-functional type, dimensions, priority, confidence, and stable temporary-to-final IDs. |
| 6 | Conflict Detection | `lib/agents/conflictDetection.js` | Compares the complete classified set; returns evidence-supported conflicts, duplicates, and dependencies without silently resolving them. |
| 7 | Compliance | `lib/agents/compliance.js` | Retrieves regulation/policy evidence for the stated jurisdictions and maps each requirement only to supplied evidence. |
| 8 | Security and Privacy | `lib/agents/securityPrivacy.js` | Retrieves security-standard/policy evidence and identifies security/privacy concerns, controls, and review needs. |
| 9 | Risk Analysis | `lib/agents/riskAnalysis.js` | Assesses project, requirement, conflict, compliance, and security context; returns likelihood, impact, severity, and mitigations. |
| 10 | SDLC Selection | `lib/agents/sdlcSelection.js` | Retrieves SDLC rules; compares Agile, DevSecOps, Spiral, V-Model, Waterfall, and hybrid models and proposes a project workflow. |
| 11 | Documentation | `lib/agents/documentation.js` | Retrieves SRS/requirements templates; generates SRS sections, user stories, use cases, acceptance criteria, and requirement traceability. |
| 12 | Validation | `lib/agents/validation.js` | Combines model review with deterministic checks for per-agent citation validity, unknown IDs, missing traceability, and weak requirement statements. |
| 13 | Human Approval | `lib/agents/humanApproval.js` and `lib/storage.js` | Creates owner-review tasks. The signed-in project owner records each decision; the server stores reviewer identity, timestamp, note, and an audit entry. |

`lib/agents/index.js` is the module registry. `lib/agents/shared.js` supplies a common JSON-call helper and RAG evidence formatting. The agents do not share hidden mutable state: the Coordinator passes each stage's explicit output to the next stage.

## Ordered analysis and handoffs

The authenticated `POST /api/pipeline/analyze` endpoint accepts the project, chat transcript, and pasted sources and streams Server-Sent Events. A `stage` event is emitted when a real stage starts/completes; the final event contains the result or a clarification gate.

1. **Extraction** turns natural-language input into candidate requirements and preserves short source excerpts.
2. **Clarification** checks only material ambiguity in the core scope. If it returns blocking questions, the Coordinator returns them together in one batch and does not run later stages. High-level answers suffice; non-blocking gaps can be recorded as assumptions/TBD and routed to human review rather than blocking the pipeline.
3. **Classification** assigns requirement metadata. The Coordinator normalizes IDs, types, confidence, and provenance before handing off.
4. **Conflict Detection** sees the entire normalized requirement set.
5. **Compliance** and **Security/Privacy** each retrieve their own evidence and make separate calls. The deterministic compliance rules then downgrade unsupported, un-retrieved, jurisdiction-mismatched, or illustrative legal evidence to `unverified`.
6. **Risk Analysis** sees requirements, conflicts, compliance gaps, and security findings.
7. **SDLC Selection** sees requirements and risks plus its separately retrieved SDLC rules.
8. **Documentation** sees the full validated analysis context and retrieved templates.
9. **Validation** checks citations against the retrieval set for the *same agent*, traceability IDs, and requirement coverage.
10. **Human Approval** creates pending tasks, with low-confidence or high-severity issues flagged for review.

The Clarification Agent's questions are answered in the chat and the pipeline is run again from extraction. This deliberate restart ensures that new answers are reflected in every downstream output; it does not pretend to resume an old model call. The final result contains the successful run's stage audit records.

## Model pool and capacity handling

Generation calls default to `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, and `gemini-3.1-flash-lite`. `GOOGLE_MODEL` is tried first, then the remaining pool members are attempted immediately on a high-demand/capacity response; `GOOGLE_MODEL_POOL` overrides the defaults. If every model is busy, the pool waits with exponential backoff and jitter before cycling again. Embedding calls have a separate `GOOGLE_EMBEDDING_MODEL_POOL`; its models must support the embedding endpoint. Capacity retries are bounded by `GOOGLE_MAX_CAPACITY_RETRIES` (default 8); if all models remain at capacity, the request returns an explicit failure so the UI can discard the unsuccessful draft instead of appearing to run indefinitely. A timed-out model call tries the remaining configured models before returning an explicit timeout error. Network failures, authentication errors, invalid-model errors, malformed output, and other failures are returned without automatic retries.

All generation and embedding calls share a FIFO in-process queue, limited by `GOOGLE_MAX_CONCURRENT_CALLS` (default 3). `GOOGLE_RETRY_BASE_MS` and `GOOGLE_RETRY_MAX_MS` configure the initial and maximum exponential wait (defaults 1000 ms and 60000 ms). `GOOGLE_REQUEST_TIMEOUT_MS` controls the per-model request timeout (default 30000 ms). The queue is held in server memory: it smooths concurrent requests but is not a durable job queue and does not survive a server restart. Model IDs must be available to the configured project; a valid fallback list and an available provider are still required for successful completion.

## Communication and trust boundaries

- Each model agent has one JSON input and one JSON output contract described in [pipeline-schemas.md](pipeline-schemas.md). There is no shared conversation between specialist model calls unless the Coordinator explicitly includes relevant prior output.
- `shared.ask()` labels the project description, conversation, and pasted documents as untrusted data and instructs the model to ignore instructions embedded in that data. This is a prompt-injection mitigation, not a proof against prompt injection.
- RAG evidence is included as a separate, explicit prompt block. Agents are told to cite only IDs in that block and to state evidence gaps.
- Server-side authentication scopes state, analysis archives, PDF downloads, and approvals to the current account. The application does not implement approver roles/RBAC: the account owner is the approver.
- The result's `auditTrail` records stage names, start/end timestamps, output hashes, and cited evidence IDs. It makes the run inspectable; it is not a tamper-proof regulatory audit service.

## Explaining the design in a demonstration

To show the RAG code path, open `lib/agents/compliance.js`, follow its `retrieve()` call into `lib/agents/shared.js`, then into `lib/kb.js`, and finally show the retrieved evidence block passed into the Compliance Agent prompt. Repeat with `lib/agents/sdlcSelection.js` for SDLC rules. To show coordination, start at `lib/coordinator.js` and follow each `execute()` call and JSON handoff. To show deterministic control, open `lib/complianceRules.js` and `lib/agents/validation.js`.
