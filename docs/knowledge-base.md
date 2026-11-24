# Knowledge base

`data/knowledge-base.json` is the versioned, authorised source every retrieval-grounded agent draws from. It's a seed set — **37 illustrative items**, not real regulatory text — meant to demonstrate the mechanism and be easy to extend with your institution's actual approved documents.

## Categories (matching the brief)

| Category | What it holds | Count in the seed set |
|---|---|---|
| `terminology` | Financial terms and business-process definitions | 5 |
| `policy` | Organisational policies and controls | 5 |
| `regulation` | Regulatory requirements | 7 |
| `security-standard` | Security standards | 5 |
| `requirement-guideline` | Requirement-engineering guidelines | 4 |
| `sdlc-rule` | SDLC selection rules | 5 |
| `template` | Templates for SRS, user stories, use cases | 3 |
| `approved-project` | Previously approved project documents | 3 |

## Every item's metadata

```json
{
  "id": "REG-003",
  "category": "regulation",
  "title": "Payment Card Industry Data Security Standard (PCI DSS)",
  "content": "...",
  "source": "PCI DSS v4.0 (illustrative summary)",
  "jurisdiction": "Global",
  "effective_date": "2024-03-31",
  "version": "4.0",
  "applicability": ["payment", "fraud", "banking"]
}
```

- `source`, `jurisdiction`, `effective_date`, `version` and `applicability` are exactly the fields the brief asks every knowledge item to carry.
- `applicability` is a list of use-case ids (`loan`, `banking`, `onboarding`, `fraud`, `payment`, `analytics`, `insurance`, `reporting`) or `"all"`, and is one of the two retrieval filters (alongside `category`).

## Browsing it

The **Knowledge base** tab (in the results view, after a run) lists every item with its full metadata, filterable by category — this is deliberately a plain, read-only browser, so you can see exactly what evidence any citation chip is pointing at.

## Versioning and embeddings

Adding, editing or re-versioning an item just means editing the JSON file — there's no separate authoring tool. Each item's embedding is computed once (via Google's `gemini-embedding-001`) and cached in `data/.kb-embeddings-cache.json`, keyed by a content hash; editing an item's title, content or version automatically invalidates its cached embedding and it's recomputed on the next run. Delete the cache file to force a full recompute.

## Extending this into a real, authorised knowledge base

This seed set is meant to be replaced, not relied on. A real deployment would need:
- Actual approved regulatory, policy and security documents, ideally chunked more granularly than these single-paragraph summaries.
- A sign-off workflow for adding/versioning items (the brief's "authorised" requirement — nothing here currently gates who can edit `knowledge-base.json`).
- Superseding logic when a new version of a regulation replaces an old one, rather than just editing in place.
- At a larger scale than ~40 items, a real vector database rather than in-memory cosine similarity — this implementation's approach works fine up to roughly a few thousand items, but wasn't built to scale past that.
