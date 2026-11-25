# Pipeline request and response schemas

All agent APIs require an authenticated browser session. The agent routes use JSON; the analysis route streams Server-Sent Events so the interface can display actual stage progress.

## Project chat — `POST /api/project/turn`

Request:

```json
{
  "project": { "title": "Payments", "description": "Build a transfer service", "jurisdictions": [] },
  "conversation": [{ "speaker": "user", "text": "Build a transfer service" }],
  "userMessage": "Build a transfer service"
}
```

Response data:

```json
{
  "message": "Which countries or regions will the service operate in?",
  "topicsCovered": ["business objective"],
  "jurisdictionsMentioned": []
}
```

The browser adds the message to the conversation and sends the full context on the next turn. `speaker` is `user` or `assistant`.

## Coordinated analysis — `POST /api/pipeline/analyze`

Request:

```json
{
  "project": { "title": "Payments", "description": "...", "jurisdictions": ["Canada"] },
  "conversation": [{ "speaker": "user", "text": "..." }, { "speaker": "assistant", "text": "..." }],
  "sources": [{ "id": "source-1", "title": "Existing policy", "text": "Masked pasted text" }]
}
```

The response is `text/event-stream`. Each event is a JSON object prefixed by `data: `:

```json
{ "type": "stage", "stage": { "key": "compliance", "label": "Compliance mapping (RAG)", "status": "active", "agent": "Compliance Agent" } }
{ "type": "stage", "stage": { "key": "compliance", "label": "Compliance mapping (RAG)", "status": "done", "agent": "Compliance Agent" } }
```

Clarification event:

```json
{
  "type": "result",
  "data": {
    "needsClarification": true,
    "questions": [{ "id": "JURISDICTION", "requirementRef": "project", "question": "...", "reason": "..." }],
    "extractedRequirements": [],
    "auditTrail": [],
    "complete": false
  }
}
```

The client adds the answers to the conversation and repeats the analysis route. Completed results use:

```text
{
  project,
  requirements: [{ id, tempId, statement, source, sourceExcerpt, type, dimensions, priority, confidence }],
  conflicts: [{ kind, requirementIds, description, evidence }],
  compliance: [{ requirementId, status, jurisdiction, citedEvidenceIds, evidence, confidence, gap }],
  security: [{ requirementId, kind, statement, threatOrConcern, control, citedEvidenceIds, evidence, confidence, needsReview }],
  risks: [{ id, description, category, likelihood, impact, severity, mitigation, residualRisk, relatedRequirementIds, confidence }],
  sdlc: { recommendedModel, recommendationRationale, candidates, workflow },
  srs: { purpose, scope, functionalRequirements, nonFunctionalRequirements, userStories, useCases, interfaces, securityPrivacy, compliance, operations, generationNotes? },
  traceability: [{ requirementId, source, evidenceIds, srsSection }],
  validation: { issues, citationViolations, ruleChecksPassed },
  approvalTasks, evidence, evidenceByAgent, auditTrail, complete, createdAt
}
```

Before validation, the coordinator normalizes Documentation Agent output: malformed optional SRS sections become safe empty values, missing requirement references and traceability rows are restored from the validated requirement set, and malformed nested story/use-case fields are made render-safe. Any repairs are surfaced in `srs.generationNotes`. Retrieved documentation evidence is retained for citation validation.

Errors are emitted as `{ "type": "error", "error": "...", "code": "..." }`; malformed or invalid requests made before the stream starts use the standard JSON error shape.

## Persistence and review

- `PUT /api/state` stores the signed-in user's in-progress workspace (schema version 3).
- `GET /api/analyses` lists only that account's saved analyses. `POST /api/analyses` archives a completed project, results, original brief, supporting sources, discovery conversation, and structured clarification question/answer pairs.
- `GET /api/analyses/:id` and `DELETE /api/analyses/:id` are account-scoped.
- `POST /api/analyses/:id/approval` accepts `{ "requirementId": "FR-001", "status": "approved|changes_requested", "note": "" }`. Use `__analysis__` for the overall owner decision. The server records reviewer identity and timestamp in the saved analysis audit trail.
- An overall `changes_requested` decision opens the saved input/clarification view. The owner can add a change request and rerun; a completed revision is archived as a new analysis, preserving the prior version and its review trail.
- `GET /api/analyses/:id/srs.pdf` returns an authenticated PDF download.
- `GET /api/kb` returns the browsable local knowledge base.
