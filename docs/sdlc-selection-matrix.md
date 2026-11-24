# SDLC selection heuristics

Base heuristics from the problem statement, used to steer the SDLC-selection portion of the orchestrator prompt:

| Project condition | Suitable SDLC approach |
|---|---|
| Stable requirements and extensive approvals | Waterfall |
| Strict verification and validation | V-Model |
| High uncertainty or technical risk | Spiral |
| Frequently changing requirements | Agile |
| Continuous secure deployment | DevSecOps |
| High regulation with evolving requirements | Agile–V-Model or DevSecOps hybrid |

## How the prototype uses this

The SDLC-Selection agent retrieves the most relevant of these rules from the knowledge base for the specific requirement/risk profile (see `rag-workflow.md`), then scores **6 candidates** against them — each with an independent 0–100 suitability score, a citation to the specific rule(s) that justified it, a one-sentence justification, and exactly 2 pros and 2 cons. The top-scoring candidate is marked "Recommended" and its workflow (5–6 phases, each with activities, a responsible role, and an approval gate) is generated to match it. It then asks for a project-specific workflow: 5–6 phases, each with activities, a responsible role, and an approval gate, so the recommendation isn't just a label but a usable plan.

In a production system, this heuristic table would be the deterministic half of a **hybrid** selection engine (per problem-statement step 14): rule-based scoring on requirement stability, regulatory criticality, security risk, complexity, and change frequency, combined with an LLM-generated explanation — with the final choice still requiring sign-off from the project manager, architect, security team, and compliance officer.
