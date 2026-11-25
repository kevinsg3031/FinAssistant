# Knowledge base

`data/knowledge-base.json` is the versioned source collection used by the RAG agents. Its **37 records are illustrative demo material**, not authoritative regulatory text. The labels and content are intended to demonstrate retrieval and evidence flow; verify obligations against approved primary sources.

## Categories

| Category | Purpose |
|---|---|
| `terminology` | Financial terms and process definitions |
| `policy` | Organizational policies and controls |
| `regulation` | Illustrative regulatory summaries |
| `security-standard` | Security and privacy control material |
| `requirement-guideline` | Requirements engineering guidance |
| `sdlc-rule` | Lifecycle selection criteria |
| `template` | SRS, story, use-case, and traceability guidance |
| `approved-project` | Example project records |

## Record shape

```json
{
  "id": "REG-003",
  "category": "regulation",
  "title": "Example financial control",
  "content": "Evidence content...",
  "source": "Source and version description",
  "jurisdiction": "Global",
  "effective_date": "2024-03-31",
  "version": "1.0",
  "applicability": ["payment", "banking"]
}
```

`applicability` is retained as metadata and supports the optional `useCase` filter in `lib/kb.js`; the new project-description pipeline does not choose a predefined use case, so its retrieval filters by category and project jurisdictions. Jurisdiction matching is conservative and documented in [rag-workflow.md](rag-workflow.md).

## Retrieval cache and browsing

Embedding vectors are cached in `data/.kb-embeddings-cache.json`. Editing a title, content, or version changes the content fingerprint and causes its vector to be recomputed. The Knowledge base tab and `GET /api/kb` expose record metadata/content but never expose embeddings.

To extend the collection responsibly, use approved source text, add effective dates and version provenance, record jurisdiction precisely, review records before use, and establish a change/supersession process. The demo has no authoring approval or regulatory-update feed.
