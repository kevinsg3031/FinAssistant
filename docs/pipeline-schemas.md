# Pipeline request/response schemas

Every stage is a separate `POST` to `/api/pipeline/<stage>`, called by the client in sequence (see `agent-architecture.md` for why). Each returns `{"ok":true,"data": ...}` on success or `{"ok":false,"error":"...","code":"auth"|"rate_limited"|"other"}` on failure.

### `/api/pipeline/extract`
Request: `{useCase, interviews: [{roleLabel, transcript:[{speaker,text}]}], sources: [{type, masked}]}`
Response: `{requirements: [{tempId, statement, sourceRole}]}`

### `/api/pipeline/clarify-check`
Request: `{requirements}` (the array above)
Response: `{items: [{tempId, status: "clear"|"needs_clarification", question}]}`
If any item needs clarification, the client shows the clarify panel and merges your answers into the matching requirement's `statement` client-side (no extra call) before continuing.

### `/api/pipeline/classify`
Request: `{useCase, requirements}`
Response: `{requirements: [{tempId, id, statement, sourceRole, categories:[...], priority}], conflicts: [{a, b, description}]}`

### `/api/pipeline/compliance`
Request: `{useCase, requirements}` (using the classified list, with real `id`s)
Response: `{compliance: [{requirementId, regulation, jurisdiction, citedEvidenceIds, confidence, gap, evidence}], derivedSecurityRequirements: [{statement, citedEvidenceIds, basedOnRequirementId}]}`
`evidence` is the server-resolved, full metadata for each cited knowledge-base id (see `knowledge-base.md`).

### `/api/pipeline/risk`
Request: `{useCase, requirements, compliance}`
Response: `{risks: [{id, description, category, severity, relatedRequirementIds}]}`

### `/api/pipeline/sdlc`
Request: `{useCase, requirements, risks}`
Response: `{candidates: [{model, pct, justification, citedEvidenceIds, evidence, pros:[...], cons:[...]}], workflow: [{phase, activities:[...], role, gate}]}`

### `/api/pipeline/document`
Request: `{requirements, compliance, conflicts}`
Response: `{traceability: [{requirementId, source, artifact}], validation: [{requirementId, needsReview, reason}]}`
The client merges `validation` and each requirement's matching `compliance.confidence` back onto the requirement objects to produce the final `needsReview`/`confidence` fields shown in the Requirements tab.

### `/api/interview/turn`
Request: `{useCase, roleLabel, transcript}`
Response: `{message, done, topicsCovered}`

### `/api/kb`  (GET, no body)
Response: the full knowledge base (see `knowledge-base.md`), no API key required.

## Extending a schema
Add a field to the relevant agent's prompt and JSON shape in `lib/agents.js`, then add a matching column/element in the corresponding render branch of `renderResultsTabs()` in `public/index.html`.
