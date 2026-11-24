# Stakeholders and input sources

## Stakeholder identification

The app collects requirements through **real, adaptive conversations**, one per stakeholder, because each role surfaces a different category of requirement and a fixed questionnaire can't follow up on a vague or inconsistent answer. Nine roles are built in:

| Role | What their conversation tends to surface |
|---|---|
| Customers & end users | Pain points, desired outcomes, trust |
| Business analysts | Business objective/KPI, current process, business rules |
| Product owners | Release priority, acceptance criteria, scope |
| Software architects & developers | Integrations, non-functional targets, technical constraints |
| Information-security teams | Data classification, auth/encryption/access control, threat model |
| Compliance & legal officers | Applicable regulations, consent/retention, reporting obligations |
| Risk-management teams | Worst-case impact, existing controls/gaps, escalation thresholds |
| Operations personnel | Manual steps, exception handling, SLAs |
| Auditors & regulators | Audit-trail evidence, prior findings, reporting format/frequency |

There's no fixed script per role — the Stakeholder Interaction agent (`POST /api/interview/turn`, one call per turn) is given a shared list of 13 topics from the brief (business objectives, users & roles, existing workflow, inputs/outputs/business rules, exceptional conditions, data collection & retention, authentication & authorisation, financial transaction limits, audit & reporting, performance & availability, integration with existing systems, regulatory & security constraints, schedule & budget) and decides live which are relevant to *this* role, what to ask next, and whether an answer needs a follow-up. See `agent-architecture.md` for how the conversation loop works.

In the UI: pick a use case, pick a stakeholder role, and just chat — type an answer, the agent asks the next question or a follow-up, and so on until it judges the relevant ground is covered (or you click **End interview now**). You can run as many role conversations as you like per use case; they show as removable chips, and every generated requirement is tagged with the specific role that raised it (the **Raised by** column on the Requirements tab).

Before an interview starts, the workspace shows a contextual briefing for the selected role: its perspective, relevant areas to explore, and useful information to have ready. The briefing changes with the selected role and does not repeat the use-case preview or first-page workflow.

## Input sources

Beyond structured interviews, the **Additional input sources** panel accepts free-text from any of the ten source types named in the brief: stakeholder conversations, interview transcripts, questionnaires, emails/meeting notes, existing requirement documents, banking policies/procedures, regulatory/compliance documents, API/database specifications, legacy-system documentation, and incident reports/audit findings. Pick the type, paste the content, and click **Classify & add**.

## Sensitive-data classification and masking

Before any interview answer or pasted source is included in the prompt sent to Claude, it passes through a client-side masking pass (`maskSensitive()`) that pattern-matches and redacts:
- Card/account-style digit sequences (12–19 digits, with optional spaces/dashes) → all but the last 4 digits replaced with `•`
- Shorter national-ID-style digit sequences (9–12 digits) → same masking
- Email addresses → local part truncated to its first character (`j***@bank.com`)
- `password` / `pin` / `cvv` / `otp` key–value pairs → value replaced with `[REDACTED]`

Adding a source shows a badge: **"Sensitive data found — N field(s) masked"** or **"No sensitive patterns detected."** Only the masked text is ever stored in the page's state or sent in the prompt — the original raw string is discarded immediately after masking.

**Important caveat:** this is a lightweight, regex-based demo of the *concept* the brief asks for, not a production data-loss-prevention system. It will miss context-dependent sensitive data (names, addresses, free-text medical/financial detail) and can occasionally over- or under-match. A production build would classify data against a real sensitivity taxonomy (public/internal/confidential/restricted, matching the information-security interview template) and apply a proper PII/PCI detection library or managed DLP service before anything reaches an LLM.
