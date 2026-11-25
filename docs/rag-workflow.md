# Retrieval-grounded generation (RAG)

RAG is implemented in the running analysis, not simulated in the interface. The retrieval path is:

```text
specialist agent
  -> lib/agents/shared.js: retrieve(...)
  -> lib/kb.js: retrieve(...)
  -> category + jurisdiction filters
  -> cached document/query embeddings
  -> cosine ranking
  -> evidence block in the specialist prompt
  -> cited IDs and evidence returned with the analysis
```

## Retrieval implementation

1. `lib/kb.js` loads `data/knowledge-base.json`. The knowledge base records include an ID, category, title/content, source, jurisdiction, effective date, version, and applicability metadata.
2. `ensureEmbeddings()` computes document vectors in batches and stores them in `data/.kb-embeddings-cache.json`, keyed by each item's title/content/version fingerprint and embedding model. Cached vectors are reused while those values are unchanged.
3. Each RAG agent builds a query from its task and project context. `retrieve()` filters the candidate pool by allowed categories and jurisdiction, embeds the query, ranks candidates using cosine similarity, and returns the top K records with metadata and scores. The project pipeline does not use a predefined use-case filter.
4. `evidenceText()` formats the retrieved IDs, titles, jurisdiction, source, version, effective date, and content into an explicit evidence block. The agent prompt requires that citations use only those IDs and that missing or uncertain support be reported as a gap.
5. Each output carries `citedEvidenceIds`. The Coordinator resolves them to the full records actually retrieved by that specific agent. The UI displays citation chips with source metadata.

## Retrieval scopes by agent

| Agent | Allowed categories | Maximum retrieved records |
|---|---|---:|
| Compliance | `regulation`, `policy` | 8 |
| Security and Privacy | `security-standard`, `policy` | 8 |
| SDLC Selection | `sdlc-rule` | 8 |
| Documentation | `template`, `requirement-guideline` | 5 |

Jurisdiction filtering is deliberately conservative. `All`, `Global`, and `Group-wide` records are eligible across jurisdictions; other records must exactly match a supplied jurisdiction or be an exact member of a slash/comma-separated label. The system does not guess aliases (for example, it does not assume that `National` means a particular country). If jurisdiction is missing, the Coordinator blocks compliance analysis until the owner answers.

## Deterministic compliance checks

`lib/complianceRules.js` runs after the Compliance Agent and before Risk Analysis:

- Invalid or missing statuses become `unverified`.
- A mapping with no retrieved evidence is `unverified`.
- A cited ID not present in the Compliance Agent's own retrieval result is removed and the mapping is `unverified`.
- Evidence with a mismatched jurisdiction makes the mapping `unverified`.
- Evidence whose source identifies it as illustrative, demo, or seed cannot establish legal applicability; the mapping is `unverified`.

The Validation Agent separately checks compliance, security, SDLC, and documentation citations against the corresponding agent's own retrieval set. A citation from another agent's context is not treated as valid evidence.

## What this mitigates—and what it does not

RAG makes the evidence path inspectable and limits unsupported citation IDs. The deterministic checks stop the model from turning an illustrative seed citation into a `supported` legal mapping. Confidence values remain model estimates, not calibrated probabilities; cosine similarity measures textual closeness, not legal relevance.

The included knowledge base is a 37-record illustrative seed, not authoritative regulation. The implementation uses top-K ranking without a universal relevance threshold, and an LLM can still misinterpret a retrieved passage, omit an applicable rule, or produce a weak explanation. Human review against maintained primary sources is required before operational or legal use.
