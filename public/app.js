const STAGES = [
  ["extract", "Requirement extraction"],
  ["clarify", "Clarification check"],
  ["classify", "Requirement classification"],
  ["conflicts", "Conflict and duplication analysis"],
  ["compliance", "Compliance mapping (RAG)"],
  ["security", "Security and privacy review (RAG)"],
  ["risk", "Risk analysis"],
  ["sdlc", "SDLC selection (RAG)"],
  ["documentation", "SRS and traceability"],
  ["validation", "Consistency and evidence validation"],
  ["approval", "Owner approval checkpoint"],
];
const PAGES = ["Overview", "Chat", "Requirements", "Quality, Compliance & Risk", "SDLC & Workflow", "SRS Documentation", "Knowledge Base"];
const state = {
  user: null,
  project: { title: "", description: "", jurisdictions: [] },
  conversation: [],
  clarifications: [],
  sources: [],
  pipeline: null,
  page: "Overview",
  tab: "Requirements",
  archiveId: null,
  kbCache: null,
  kbFilter: "",
  busy: false,
  notice: "",
};
let authMode = "login";
let persistTimer;

function q(id) { return document.getElementById(id); }
function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = value == null ? "" : String(value);
  return element.innerHTML;
}
function makeId() { return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function maskSensitive(text) {
  let count = 0;
  const replace = (value) => {
    count += 1;
    const digits = value.replace(/\D/g, "");
    return `••••${digits.slice(-4)}`;
  };
  let masked = String(text)
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, replace)
    .replace(/\b\d{9,12}\b/g, replace)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => { count += 1; return "[EMAIL REDACTED]"; })
    .replace(/\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+/gi, (match) => { count += 1; return match.replace(/[:=]\s*\S+$/, ": [REDACTED]"); });
  return { masked, count };
}
function api(url, options = {}) {
  return fetch(url, options).then(async (response) => {
    let result;
    try { result = await response.json(); } catch { throw new Error("The server returned an unreadable response."); }
    if (response.status === 401) {
      lockWorkspace();
      throw new Error(result.error || "Please sign in to continue.");
    }
    if (!response.ok || !result.ok) throw new Error(result.error || "Request failed.");
    return result.data;
  });
}
function post(url, data) {
  return api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
}
function persistableState() {
  if (state.archiveId && state.pipeline?.complete) {
    return { version: 3, phase: "analysis", project: state.project, conversation: [], sources: [], archiveId: state.archiveId };
  }
  return {
    version: 3, phase: state.pipeline ? "analysis" : "intake",
    project: state.project, conversation: state.conversation, sources: state.sources,
    pipeline: state.pipeline, tab: state.tab,
  };
}
function schedulePersistence() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistState().catch((error) => { console.error("Could not save workspace:", error); }), 300);
}
async function persistState() {
  if (!state.user) return;
  clearTimeout(persistTimer);
  await api("/api/state", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(persistableState()),
  });
}
function appendMessage(speaker, text) {
  state.conversation.push({ speaker, text, createdAt: new Date().toISOString() });
}
function syncBriefInputs() {
  if (q("projectTitle")) q("projectTitle").value = state.project.title || "";
  if (q("projectDescription")) q("projectDescription").value = state.project.description || "";
}
function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  const next = theme === "dark" ? "light" : "dark";
  q("themeToggle").setAttribute("aria-label", `Switch to ${next} mode`);
  q("themeToggle").title = `Switch to ${next} mode`;
  q("themeIcon").innerHTML = theme === "dark"
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>'
    : '<path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z"/>';
  if (persist) localStorage.setItem("finassistant-theme", theme);
}
function initializeTheme() {
  const saved = localStorage.getItem("finassistant-theme");
  setTheme(saved === "light" || saved === "dark" ? saved : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), false);
}
function setAccountMenu(open) {
  q("accountPopover").hidden = !open;
  q("accountMenuToggle").setAttribute("aria-expanded", String(open));
}
function renderMessages() {
  return state.conversation.map((message) => `<div class="chat-message ${message.speaker === "user" ? "user" : "assistant"}">${escapeHtml(message.text)}</div>`).join("");
}
function renderIntro() {
  const ready = state.conversation.length > 0;
  const transcript = ready
    ? renderMessages()
    : `<div class="brief-form">
        <label for="projectTitle">Project name</label>
        <input id="projectTitle" maxlength="200" placeholder="e.g. Real-time payments platform">
        <label for="projectDescription">Project description</label>
        <textarea id="projectDescription" maxlength="100000" placeholder="Describe the system, who it serves, and what it should achieve. Start with what you know; details can be TBD."></textarea>
        <button class="run-btn" id="startProjectBtn" type="button" ${state.busy ? "disabled" : ""}>Start chat</button>
        <div class="hint">Do not include real customer data, credentials, or confidential identifiers.</div>
      </div>`;
  return `<div class="page-heading"><div><h2>Project Chat</h2></div></div>
    ${state.busy ? renderStageList() : ""}
    ${state.notice ? `<div class="pipeline-error">${escapeHtml(state.notice)}</div>` : ""}
    <div class="elicitation-grid">
      <section class="page-panel chat-panel">
        <h3 class="chat-panel-heading">${ready ? escapeHtml(state.project.title || "Project conversation") : "Project brief"}</h3>
        ${ready ? `<details class="brief-summary"><summary>Project brief</summary><label for="projectTitle">Project name</label><input id="projectTitle" value="${escapeHtml(state.project.title)}" readonly><label for="projectDescription">Description</label><textarea id="projectDescription" readonly>${escapeHtml(state.project.description)}</textarea></details>` : ""}
        <div class="project-chat" id="projectChat" aria-live="polite">${transcript}</div>
        ${ready ? `<form class="chat-composer" id="chatForm">
          <textarea id="chatInput" aria-label="Your answer" placeholder="Describe features, user roles, limits, or compliance rules…" ${state.busy ? "disabled" : ""}></textarea>
          <button class="run-btn" id="chatSend" type="submit" ${state.busy ? "disabled" : ""}>Send</button>
        </form>
        <div class="chat-actions"><button class="run-btn" id="runAnalysis" type="button" ${state.busy ? "disabled" : ""}>${state.busy ? "Analysis running…" : "Run analysis"}</button><div class="hint" id="statusMessage">${escapeHtml(state.notice || "Analysis pauses only if essential clarification is needed.")}</div></div>` : ""}
        <details class="chat-sources">
          <summary>Supporting text (optional)</summary>
          <label for="sourceTitle">Source title</label>
          <input id="sourceTitle" maxlength="160" placeholder="Policy or requirements">
          <label for="sourceText">Paste text</label>
          <textarea id="sourceText" maxlength="30000" placeholder="Paste authorised information. Sensitive patterns are masked before analysis."></textarea>
          <button class="small-btn" id="addSourceBtn" type="button">Add source</button>
          <div id="sourceList" class="source-list"></div>
        </details>
      </section>
    </div>`;
}
function renderStageList() {
  const status = state.pipeline?.stageStatus || {};
  return `<div class="stage-list panel">${STAGES.map(([key, label]) => {
    const stage = status[key] || "pending";
    const marker = stage === "done" ? "✓" : stage === "active" ? "…" : stage === "waiting" ? "Ⅱ" : stage === "failed" ? "!" : "○";
    return `<div class="stage-item ${stage}"><span class="stage-icon">${marker}</span> ${escapeHtml(label)}</div>`;
  }).join("")}</div>`;
}
function renderClarification() {
  const questions = state.pipeline.questions || [];
  return `<div class="page-heading"><div><h2>Clarification Questions</h2></div></div>
    ${renderStageList()}<section class="clarify-panel"><h3>Clarification needed before analysis can continue</h3>
    <p class="step-desc">Answer the questions below. Regulatory mapping requires the countries or regions in scope.</p>
    ${questions.map((item, index) => `<div class="clarification-row"><label for="clarification-${index}">${escapeHtml(item.question)}</label><textarea class="clarify-answer" id="clarification-${index}" data-clarification="${index}" placeholder="Your answer…" required></textarea><div class="hint">${escapeHtml(item.reason || "")}</div></div>`).join("")}
    <button class="run-btn" id="submitClarifications" type="button" ${state.busy ? "disabled" : ""}>Continue analysis</button>
  </section>`;
}
function renderEvidence(items = []) {
  if (!items.length) return `<span class="hint">No retrieved evidence was attached to this finding.</span>`;
  return `<div>${items.map((item) => `<span class="evidence-chip" title="${escapeHtml(item.title)} — ${escapeHtml(item.source)} · ${escapeHtml(item.jurisdiction)} · v${escapeHtml(item.version)}">${escapeHtml(item.id)} · ${escapeHtml(item.title)}</span>`).join("")}</div>`;
}
function renderRequirementTab(pipeline) {
  const approvals = pipeline.approvalTasks || [];
  return `<div class="results">
    <h2>Classified requirements</h2>
    <p class="step-desc">Each item is linked to its source, classified across financial-software dimensions, and assigned a confidence score. Review and approve the outputs before treating them as validated.</p>
    <table><thead><tr><th>ID / kind</th><th>Requirement</th><th>Dimensions</th><th>Priority</th><th>Confidence</th><th>Source</th><th>Owner review</th></tr></thead><tbody>
      ${(pipeline.requirements || []).map((item) => {
        const approval = approvals.find((task) => task.requirementId === item.id);
        return `<tr><td class="mono">${escapeHtml(item.id)}<div class="hint">${escapeHtml(item.type || "")}</div></td><td>${escapeHtml(item.statement)}${item.assumptions?.length ? `<div class="hint">Assumptions: ${escapeHtml(item.assumptions.join("; "))}</div>` : ""}</td><td>${escapeHtml((item.dimensions || []).join(", "))}</td><td>${escapeHtml(item.priority || "—")}</td><td>${Math.round((item.confidence || 0) * 100)}%</td><td>${escapeHtml(item.source || "—")}<div class="hint">${escapeHtml(item.sourceExcerpt || "")}</div></td><td><span class="badge">${escapeHtml(approval?.status || "pending")}</span><div class="review-actions"><button data-review="${escapeHtml(item.id)}|approved">Approve</button><button data-review="${escapeHtml(item.id)}|changes_requested">Request changes</button></div></td></tr>`;
      }).join("")}
    </tbody></table>
  </div>`;
}
function renderSrsTab(pipeline) {
  const srs = pipeline.srs || {};
  const section = (title, value) => `<h3>${escapeHtml(title)}</h3>${Array.isArray(value) ? `<ul>${value.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>` : `<p>${escapeHtml(value || "TBD")}</p>`}`;
  const stories = (srs.userStories || []).map((story) => `<div class="result-card"><strong>${escapeHtml(story.id)} — As ${escapeHtml(story.asA)}, I want ${escapeHtml(story.iWant)}, so that ${escapeHtml(story.soThat)}</strong><ul>${(story.acceptanceCriteria || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><span class="hint">Requirements: ${escapeHtml((story.requirementIds || []).join(", "))}</span></div>`).join("");
  const useCases = (srs.useCases || []).map((item) => `<div class="result-card"><strong>${escapeHtml(item.id)} — ${escapeHtml(item.name)}</strong><p>Actors: ${escapeHtml((item.actors || []).join(", "))}</p>${section("Main flow", item.mainFlow)}${section("Alternate flows", item.alternateFlows)}<span class="hint">Requirements: ${escapeHtml((item.requirementIds || []).join(", "))}</span></div>`).join("");
  return `<div class="results"><h2>${escapeHtml(srs.title || "Software Requirements Specification")}</h2>
    ${section("Purpose", srs.purpose)}${section("Scope", srs.scope)}${section("Assumptions", srs.assumptions)}
    ${section("Functional requirements", srs.functionalRequirements)}${section("Non-functional requirements", srs.nonFunctionalRequirements)}
    <h3>User stories and acceptance criteria</h3>${stories || `<p class="hint">Not generated.</p>`}
    <h3>Use cases</h3>${useCases || `<p class="hint">Not generated.</p>`}
    ${section("Interfaces", srs.interfaces)}${section("Security and privacy", srs.securityPrivacy)}
    ${section("Compliance", srs.compliance)}${section("Operations", srs.operations)}
    ${section("Risks", srs.risks)}${section("Recommended SDLC", srs.sdlc?.rationale ? `${srs.sdlc.model}: ${srs.sdlc.rationale}` : "TBD")}
    ${srs.generationNotes?.length ? section("Documentation notes", srs.generationNotes) : ""}
  </div>`;
}
function renderRecordList(title, records, body) {
  return `<div class="results"><h2>${escapeHtml(title)}</h2>${records.length ? records.map((item) => body(item)).join("") : `<p class="hint">No findings were returned.</p>`}</div>`;
}
function clarificationsFromConversation(conversation) {
  return (conversation || []).flatMap((message) => {
    if (message?.speaker !== "user" || typeof message.text !== "string") return [];
    const marker = "\nAnswer:";
    const separator = message.text.indexOf(marker);
    if (separator < 0) return [];
    const question = message.text.slice(0, separator).trim();
    const answer = message.text.slice(separator + marker.length).trim();
    return question && answer ? [{ question, answer }] : [];
  });
}
function renderInputsTab() {
  const clarificationPairs = state.clarifications.length ? state.clarifications : clarificationsFromConversation(state.conversation);
  const clarifications = clarificationPairs.length
    ? clarificationPairs.map((item, index) => `<article class="result-card" data-saved-clarification="${index}"><strong>Q: ${escapeHtml(item.question)}</strong><p>A: ${escapeHtml(item.answer)}</p></article>`).join("")
    : `<p class="hint">No clarification questions were needed for this analysis.</p>`;
  const sources = state.sources.length
    ? `<h3>Supporting input</h3>${state.sources.map((item) => `<article class="result-card"><strong>${escapeHtml(item.title || "Supporting source")}</strong><p>${escapeHtml(item.text || "")}</p></article>`).join("")}`
    : "";
  const discovery = state.conversation.filter((item) => item?.speaker && typeof item.text === "string" && !item.text.includes("\nAnswer:"));
  const transcript = discovery.length
    ? `<h3>Discovery conversation</h3>${discovery.map((item) => `<article class="result-card"><strong>${item.speaker === "assistant" ? "Assistant" : "You"}</strong><p>${escapeHtml(item.text)}</p></article>`).join("")}`
    : "";
  const revision = state.pipeline?.ownerApproval?.status === "changes_requested"
    ? `<section class="clarify-panel"><h3>Clarification requested by the project owner</h3><p class="step-desc">Add the changes or information needed. This revised run will be saved as a new analysis; the current version and its review history remain in Saved analyses.</p><label for="revisionRequest">Changes to make</label><textarea id="revisionRequest" class="clarify-answer" placeholder="Describe the requested changes at a high level…" required></textarea><button class="run-btn" id="reviseAnalysis" type="button">Revise and rerun analysis</button></section>`
    : "";
  return `<div class="results"><h2>Original input</h2><p><strong>Project:</strong> ${escapeHtml(state.project.title || "Untitled project")}</p><p>${escapeHtml(state.project.description || "No project description saved.")}</p><p><strong>Operating regions:</strong> ${escapeHtml((state.project.jurisdictions || []).join(", ") || "Not specified")}</p>${sources}<h3>Clarifying questions and answers</h3>${clarifications}${transcript}${revision}</div>`;
}
function renderCurrentTab(pipeline) {
  if (state.tab === "Inputs & clarifications") return renderInputsTab();
  if (state.tab === "Requirements") return renderRequirementTab(pipeline);
  if (state.tab === "SRS") return renderSrsTab(pipeline);
  if (state.tab === "Compliance") return renderRecordList("Compliance mappings", pipeline.compliance || [], (item) => `<article class="result-card"><strong>${escapeHtml(item.requirementId)} · ${escapeHtml(item.status)}</strong><p>${escapeHtml(item.obligation || item.gap || "No supported mapping returned.")}</p><p>Jurisdiction: ${escapeHtml(item.jurisdiction || "Unspecified")} · confidence ${Math.round((item.confidence || 0) * 100)}%</p>${renderEvidence(item.evidence)}</article>`);
  if (state.tab === "Security") return renderRecordList("Security and privacy review", pipeline.security || [], (item) => `<article class="result-card"><strong>${escapeHtml(item.kind || "Finding")} · ${escapeHtml(item.requirementId || "Project-level")}</strong><p>${escapeHtml(item.statement)}</p><p>Concern: ${escapeHtml(item.threatOrConcern)}<br>Suggested control: ${escapeHtml(item.control)}</p><span class="badge">${item.needsReview ? "Needs human review" : `${Math.round((item.confidence || 0) * 100)}% confidence`}</span>${renderEvidence(item.evidence)}</article>`);
  if (state.tab === "Risks") return renderRecordList("Risk register", pipeline.risks || [], (item) => `<article class="result-card"><strong>${escapeHtml(item.id)} · ${escapeHtml(item.severity)} — ${escapeHtml(item.category)}</strong><p>${escapeHtml(item.description)}</p><p>Likelihood: ${escapeHtml(item.likelihood)} · Impact: ${escapeHtml(item.impact)}</p><p>Mitigation: ${escapeHtml(item.mitigation)} · Residual risk: ${escapeHtml(item.residualRisk)}</p><span class="hint">Related: ${escapeHtml((item.relatedRequirementIds || []).join(", "))}</span></article>`);
  if (state.tab === "Conflicts") return renderRecordList("Conflicts and dependencies", pipeline.conflicts || [], (item) => `<article class="result-card"><strong>${escapeHtml(item.kind || "Finding")}: ${escapeHtml((item.requirementIds || []).join(" ↔ "))}</strong><p>${escapeHtml(item.description)}</p><span class="hint">${escapeHtml(item.evidence || "")}</span></article>`);
  if (state.tab === "SDLC") {
    const candidates = pipeline.sdlc?.candidates || [];
    const workflow = pipeline.sdlc?.workflow || [];
    return `<div class="results"><h2>SDLC recommendation</h2><article class="result-card"><strong>Recommended: ${escapeHtml(pipeline.sdlc?.recommendedModel || "Not specified")}</strong><p>${escapeHtml(pipeline.sdlc?.recommendationRationale || "")}</p></article><h3>Comparison with alternatives</h3>${candidates.map((item) => `<article class="result-card"><strong>${escapeHtml(item.model)} · ${Math.round(item.score || 0)}/100</strong><p>${escapeHtml(item.justification || "")}</p><p>Pros: ${escapeHtml((item.pros || []).join("; "))}<br>Cons: ${escapeHtml((item.cons || []).join("; "))}</p>${renderEvidence(item.evidence)}</article>`).join("")}<h3>Project-specific workflow</h3>${workflow.map((item) => `<article class="result-card"><strong>${escapeHtml(item.phase)}</strong><p>Activities: ${escapeHtml((item.activities || []).join("; "))}</p><p>Roles: ${escapeHtml((item.roles || []).join(", "))}</p><p>Deliverables: ${escapeHtml((item.deliverables || []).join(", "))}</p><p>Validation gate: ${escapeHtml(item.validationGate)}</p><p>Security: ${escapeHtml((item.securityControls || []).join("; "))}</p><p>Compliance: ${escapeHtml((item.complianceCheckpoints || []).join("; "))}</p></article>`).join("")}</div>`;
  }
  if (state.tab === "Traceability") return `<div class="results"><h2>Traceability matrix</h2><table><thead><tr><th>Requirement</th><th>Source</th><th>SRS section</th><th>Evidence</th></tr></thead><tbody>${(pipeline.traceability || []).map((item) => `<tr><td>${escapeHtml(item.requirementId)}</td><td>${escapeHtml(item.source || "—")}</td><td>${escapeHtml(item.srsSection || "—")}</td><td>${escapeHtml((item.evidenceIds || []).join(", "))}</td></tr>`).join("")}</tbody></table></div>`;
  if (state.tab === "Audit trail") return `<div class="results"><h2>Validation and audit trail</h2><p class="hint">Deterministic citation checks passed: ${pipeline.validation?.ruleChecksPassed ? "yes" : "no"}. Every logged stage records a hash of its output and the evidence IDs it used.</p>${(pipeline.validation?.issues || []).map((item) => `<article class="result-card"><strong>${escapeHtml(item.severity)} · ${escapeHtml(item.item)}</strong><p>${escapeHtml(item.description)}</p><span class="hint">${escapeHtml(item.recommendation || "")}</span></article>`).join("")}<h3>Agent handoffs</h3>${(pipeline.auditTrail || []).map((item) => `<article class="result-card"><strong>${escapeHtml(item.agent)} — ${escapeHtml(item.stage)}</strong><p>${escapeHtml(item.startedAt)} → ${escapeHtml(item.completedAt)}</p><p>Output SHA-256: <span class="mono">${escapeHtml(item.outputSha256 || "")}</span></p><p>Evidence: ${escapeHtml((item.evidenceIds || []).join(", ") || "none")}</p></article>`).join("")}</div>`;
  return renderKnowledgeBase();
}
function renderKnowledgeBase() {
  const items = state.kbCache || [];
  const categories = [...new Set(items.map((item) => item.category))];
  const filtered = items.filter((item) => !state.kbFilter || item.category === state.kbFilter);
  const categoryLabel = (category) => category.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `<div class="results"><h2>Local knowledge base</h2><div class="kb-filters"><button class="kb-filter" data-kb="">All (${items.length})</button>${categories.map((category) => `<button class="kb-filter" data-kb="${escapeHtml(category)}">${escapeHtml(categoryLabel(category))} (${items.filter((item) => item.category === category).length})</button>`).join("")}</div>${filtered.map((item) => `<article class="kb-item"><strong>${escapeHtml(item.id)} · ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.content)}</p><div class="kb-meta">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.source)} · ${escapeHtml(item.jurisdiction)} · v${escapeHtml(item.version)} · effective ${escapeHtml(item.effective_date)}</div></article>`).join("")}</div>`;
}
function pageHeading(title, description, status = "") {
  return `<div class="page-heading"><div><h2>${escapeHtml(title)}</h2></div>${status}</div>`;
}
function renderOverview(pipeline) {
  const requirements = pipeline?.requirements || [];
  const approvalTasks = pipeline?.approvalTasks || [];
  const approved = approvalTasks.filter((item) => item.status === "approved").length;
  const issues = pipeline?.validation?.issues || [];
  const compliance = pipeline?.compliance || [];
  const risks = pipeline?.risks || [];
  const status = pipeline?.ownerApproval?.status || "needs_review";
  const statusBadge = `<span class="status-pill ${status === "approved" ? "approved" : "needs-review"}">${status === "approved" ? "Approved" : pipeline?.complete ? "Status: Needs Review" : "No analysis yet"}</span>`;
  const metrics = [
    ["Requirements", requirements.length, pipeline?.complete ? `${approved} approved` : "Start elicitation to extract requirements", "Requirements"],
    ["Quality issues", issues.length, pipeline?.complete ? (requirements.length ? `${Math.max(0, Math.round(100 * (1 - issues.length / Math.max(requirements.length, 1))))}% completeness` : "No requirements to validate") : "Validation results will appear here", "Quality, Compliance & Risk"],
    ["Compliance findings", compliance.length, pipeline?.complete ? `${compliance.filter((item) => item.status === "supported").length} supported · ${compliance.filter((item) => item.status !== "supported").length} to review` : "Jurisdiction-aware analysis", "Quality, Compliance & Risk"],
    ["Risk findings", risks.length, pipeline?.complete ? `${risks.filter((item) => /high|critical/i.test(item.severity || "")).length} high severity` : "Project risks and mitigations", "Quality, Compliance & Risk"],
    ["SRS Documentation", pipeline?.complete ? "Generated" : "Not generated", pipeline?.complete ? "SRS and traceability available" : "SRS will be generated after analysis", "SRS Documentation"],
  ];
  const recommendedModel = pipeline?.sdlc?.recommendedModel || "Delivery approach";
  const recommendation = pipeline?.sdlc?.recommendationRationale || (pipeline?.complete ? "A project-specific delivery recommendation is ready to review." : "Your project’s recommended delivery model will appear here after analysis.");
  const ownerApproval = pipeline?.complete && state.archiveId && status !== "approved"
    ? `<section class="overview-review"><section class="approval-banner"><strong>Project owner review: ${escapeHtml(status)}</strong><p>Approve this analysis or request changes. Your decision is recorded with reviewer identity and timestamp.</p><button class="small-btn" data-owner-approval="approved">Approve analysis</button> <button class="small-btn" data-owner-approval="changes_requested">Request changes</button></section></section>`
    : "";
  return `${pageHeading("Project Overview", "Current progress across elicitation, regulatory checks, and artifacts", statusBadge)}
    <div class="overview-dashboard">
      <section class="overview-feature">
        <div class="feature-eyebrow">Recommended delivery model</div>
        <h3>${escapeHtml(recommendedModel)}</h3>
        <p>${escapeHtml(recommendation)}</p>
        ${pipeline?.complete ? `<button class="feature-link" data-page="SDLC &amp; Workflow" type="button">Explore workflow <span aria-hidden="true">→</span></button>` : ""}
      </section>
      <section class="overview-ledger">
        <div class="ledger-heading"><h3>Project signals</h3><span>${pipeline?.complete ? "Analysis summary" : "Awaiting analysis"}</span></div>
        <div class="ledger-rows">${metrics.map(([label, value, note, target]) => `<button class="ledger-row" data-page="${escapeHtml(target)}" type="button"><span class="ledger-label">${escapeHtml(label)}</span><strong class="ledger-value">${escapeHtml(value)}</strong><span class="ledger-note">${escapeHtml(note)}</span><span class="ledger-arrow" aria-hidden="true">→</span></button>`).join("")}</div>
      </section>
    </div>
    ${pipeline?.complete ? ownerApproval : `<div class="dashboard-actions"><button class="small-btn primary-dark" data-page="Chat" type="button">Start stakeholder elicitation</button>${state.archiveId ? `<button class="small-btn" id="downloadSrs">Download SRS PDF</button>` : ""}</div>`}
    ${pipeline?.complete && state.archiveId ? `<div class="dashboard-actions"><button class="small-btn" id="downloadSrs">Download SRS PDF</button><button class="small-btn" id="saveAnalysisCopy">Save copy</button></div>` : ""}`;
}
function renderQuality() {
  const options = ["Audit trail", "Compliance", "Security", "Risks", "Conflicts"];
  if (!options.includes(state.tab)) state.tab = "Audit trail";
  return `${pageHeading("Quality, Compliance & Risk", "Review validation issues, regulatory mappings, security findings, and project risks")}
    <div class="quality-subnav">${options.map((item) => `<button class="tab ${state.tab === item ? "active" : ""}" data-tab="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div>
    <section class="page-panel">${renderCurrentTab(state.pipeline)}</section>`;
}
function renderEmptyPage(title, description) {
  return `${pageHeading(title, description)}<section class="page-panel empty-page"><h3>No completed analysis yet</h3><p class="step-desc">Start stakeholder elicitation to populate this workspace with project-specific results.</p><button class="small-btn primary-dark" data-page="Chat" type="button">Go to chat</button></section>`;
}
function renderResultPage() {
  const pipeline = state.pipeline;
  if (!pipeline?.complete) return renderEmptyPage(state.page, "Analysis outputs will be available here after elicitation.");
  if (state.page === "Overview") return renderOverview(pipeline);
  if (state.page === "Chat") return `${pageHeading("Chat", "Original brief, discovery conversation, and clarification answers")}<section class="page-panel">${renderInputsTab()}</section>`;
  if (state.page === "Requirements") return `${pageHeading("Requirements", "Classified, source-linked requirements ready for owner review")}<section class="page-panel">${renderRequirementTab(pipeline)}</section>`;
  if (state.page === "Quality, Compliance & Risk") return renderQuality();
  if (state.page === "SDLC & Workflow") {
    state.tab = "SDLC";
    return `${pageHeading("SDLC & Workflow", "Recommended lifecycle model and project-specific delivery workflow")}<section class="page-panel">${renderCurrentTab(pipeline)}</section>`;
  }
  if (state.page === "SRS Documentation") {
    state.tab = "SRS";
    return `${pageHeading("SRS Documentation", "Software requirements specification, use cases, and traceability")}<section class="page-panel">${renderCurrentTab(pipeline)}</section>`;
  }
  if (state.page === "Knowledge Base") return renderKnowledgeBase();
  return renderOverview(pipeline);
}
function renderResults() {
  const pipeline = state.pipeline;
  return `${state.archiveError ? `<div class="pipeline-error">${escapeHtml(state.archiveError)}</div>` : ""}${renderResultPage()}`;
}
function render() {
  const root = q("content");
  root.innerHTML = state.pipeline?.needsClarification
    ? renderClarification()
    : state.pipeline && state.busy
      ? `${renderStageList()}${renderIntro()}`
      : state.pipeline?.complete
        ? renderResults()
        : state.page === "Overview"
          ? renderOverview(null)
          : state.page === "Chat"
            ? renderIntro()
            : state.page === "Knowledge Base"
              ? renderKnowledgeBase()
              : renderEmptyPage(state.page, "Analysis outputs will be available here after elicitation.");
  q("topbarProject").textContent = PAGES.includes(state.page) ? state.page : "FinAssistant";
  q("topbarProjectName").textContent = state.project.title ? ` · ${state.project.title}` : "";
  document.querySelectorAll(".nav-item[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === state.page));
  q("requirementsBadge").textContent = state.pipeline?.complete ? String((state.pipeline.requirements || []).length) : "";
  q("qualityBadge").textContent = state.pipeline?.complete ? String((state.pipeline.validation?.issues || []).length) : "";
  wireContent();
  renderSourceList();
  schedulePersistence();
}
function renderSourceList() {
  if (!q("sourceList")) return;
  q("sourceList").innerHTML = state.sources.map((item, index) => {
    const text = item.text || item.masked || "";
    return `<article class="source-card"><strong>${escapeHtml(item.title || item.type || `Source ${index + 1}`)}</strong><p>${escapeHtml(text.slice(0, 250))}${text.length > 250 ? "…" : ""}</p><span class="hint">${item.maskedCount ? `${item.maskedCount} sensitive pattern(s) masked` : "Added"}</span><button class="small-btn" data-remove-source="${index}" type="button">Remove</button></article>`;
  }).join("");
  q("sourceList").querySelectorAll("[data-remove-source]").forEach((button) => {
    button.onclick = () => { state.sources.splice(Number(button.dataset.removeSource), 1); renderSourceList(); schedulePersistence(); };
  });
}
function wireContent() {
  const start = q("startProjectBtn");
  if (start) start.onclick = startProject;
  const form = q("chatForm");
  if (form) form.onsubmit = (event) => { event.preventDefault(); sendChat(); };
  const send = q("chatSend");
  if (send) send.onclick = (event) => { event.preventDefault(); sendChat(); };
  const run = q("runAnalysis");
  if (run) run.onclick = runPipeline;
  const addSource = q("addSourceBtn");
  if (addSource) addSource.onclick = () => {
    const raw = q("sourceText").value.trim();
    if (!raw) return;
    const { masked, count } = maskSensitive(raw);
    const sourceTitle = maskSensitive(q("sourceTitle").value.trim() || `Pasted source ${state.sources.length + 1}`);
    state.sources.push({ id: makeId(), title: sourceTitle.masked, text: masked, maskedCount: count + sourceTitle.count });
    q("sourceText").value = "";
    q("sourceTitle").value = "";
    renderSourceList();
    schedulePersistence();
  };
  q("content").querySelectorAll("[data-page]").forEach((button) => {
    button.onclick = async () => {
      state.page = button.dataset.page;
      if (state.page === "Knowledge Base" && !state.kbCache) {
        try { state.kbCache = await api("/api/kb"); }
        catch (error) { state.notice = `Could not load the knowledge base: ${error.message}`; }
      }
      render();
    };
  });
  q("submitClarifications")?.addEventListener("click", submitClarifications);
  q("reviseAnalysis")?.addEventListener("click", reviseAnalysis);
  q("downloadSrs")?.addEventListener("click", downloadSrs);
  q("saveAnalysisCopy")?.addEventListener("click", saveAnalysisCopy);
  q("newProject")?.addEventListener("click", () => {
    if (!confirm("Start a new project? This analysis remains in Saved analyses.")) return;
    state.project = { title: "", description: "", jurisdictions: [] };
    state.conversation = []; state.clarifications = []; state.sources = []; state.pipeline = null; state.archiveId = null; state.tab = "Requirements";
    state.notice = "";
    syncBriefInputs(); render(); schedulePersistence();
  });
  q("content").querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = async () => {
      state.tab = button.dataset.tab;
      if (state.tab === "Knowledge base" && !state.kbCache) state.kbCache = await api("/api/kb");
      render();
    };
  });
  q("content").querySelectorAll("[data-kb]").forEach((button) => {
    button.onclick = () => { state.kbFilter = button.dataset.kb; render(); };
  });
  q("content").querySelectorAll("[data-review]").forEach((button) => {
    button.onclick = () => updateApproval(...button.dataset.review.split("|"));
  });
  q("content").querySelectorAll("[data-owner-approval]").forEach((button) => {
    button.onclick = () => updateApproval("__analysis__", button.dataset.ownerApproval);
  });
  const chat = q("projectChat");
  if (chat) chat.scrollTop = chat.scrollHeight;
}
function setBusy(value) {
  state.busy = value;
  const status = q("statusMessage");
  if (status) status.textContent = value ? "Working…" : "You can continue the conversation or start analysis.";
  q("startProjectBtn") && (q("startProjectBtn").disabled = value);
  q("runAnalysis") && (q("runAnalysis").disabled = value);
  q("chatSend") && (q("chatSend").disabled = value);
}
async function startProject() {
  const description = q("projectDescription").value.trim();
  if (description.length < 20) { alert("Please give a little more detail about the proposed system."); return; }
  state.notice = "";
  state.project = { title: q("projectTitle").value.trim(), description: maskSensitive(description).masked, jurisdictions: [] };
  syncBriefInputs();
  appendMessage("user", state.project.description);
  appendMessage("assistant", "Thanks, I’ve captured your project brief. You can start the analysis now. If a detail is undecided, it can be marked TBD; I’ll ask only about essential gaps together.");
  render();
}
async function sendChat() {
  const input = q("chatInput");
  if (!input || !input.value.trim() || state.busy) return;
  const message = maskSensitive(input.value.trim()).masked;
  input.value = "";
  appendMessage("user", message);
  await requestAssistantTurn(message);
}
async function requestAssistantTurn(userMessage) {
  setBusy(true);
  render();
  try {
    const result = await post("/api/project/turn", { project: state.project, conversation: state.conversation, userMessage });
    const jurisdictions = Array.isArray(result.jurisdictionsMentioned) ? result.jurisdictionsMentioned.filter((item) => typeof item === "string" && item.trim()) : [];
    if (jurisdictions.length) state.project.jurisdictions = [...new Set([...state.project.jurisdictions, ...jurisdictions])];
    appendMessage("assistant", result.message);
  } catch (error) {
    appendMessage("assistant", `I could not continue the discovery chat: ${error.message}`);
  } finally {
    setBusy(false);
    render();
  }
}
function setStage(stage) {
  if (!state.pipeline.stageStatus) state.pipeline.stageStatus = {};
  state.pipeline.stageStatus[stage.key] = stage.status;
  if (stage.status === "active") state.pipeline.currentAgent = stage.agent;
  render();
}
async function runPipeline() {
  if (!state.conversation.length || state.busy) return;
  state.pipeline = { stageStatus: {}, complete: false };
  state.tab = "Requirements";
  state.notice = "Analysis is running. Temporary model-capacity errors are retried automatically; if the service stays unavailable, this draft will be discarded.";
  setBusy(true);
  render();
  try {
    const response = await fetch("/api/pipeline/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: state.project, conversation: state.conversation, sources: state.sources }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Analysis request failed.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resultReceived = false;
    async function consume(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";
      for (const message of messages) {
        const line = message.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "stage") setStage(event.stage);
        if (event.type === "error") throw new Error(event.error || "Analysis failed.");
        if (event.type === "result") {
          resultReceived = true;
          state.notice = "";
          state.pipeline = { ...event.data, stageStatus: state.pipeline.stageStatus || {} };
          if (state.pipeline.needsClarification) state.pipeline.complete = false;
          else {
            state.pipeline.complete = true;
            await archiveCompletedAnalysis();
          }
          state.page = state.pipeline.needsClarification ? "Chat" : "Overview";
          render();
          await reader.cancel();
        }
      }
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await consume(value);
    }
    if (!resultReceived) throw new Error("The analysis stream ended without a result.");
  } catch (error) {
    state.project = { title: "", description: "", jurisdictions: [] };
    state.conversation = [];
    state.clarifications = [];
    state.sources = [];
    state.pipeline = null;
    state.archiveId = null;
    state.page = "Chat";
    state.tab = "Requirements";
    state.notice = `Analysis failed and its project draft was discarded. Start a new project to try again. Details: ${error.message}`;
    syncBriefInputs();
    renderSourceList();
  } finally {
    setBusy(false);
    render();
    if (state.notice.startsWith("Analysis failed")) {
      try { await persistState(); }
      catch (error) { console.error("Could not save the cleared workspace after analysis failure:", error); }
    }
  }
}
async function submitClarifications() {
  const answers = [...document.querySelectorAll("[data-clarification]")].map((element, index) => ({
    question: state.pipeline.questions[index],
    answer: element.value.trim(),
  }));
  if (answers.some((item) => !item.answer)) { alert("Please answer every blocking question."); return; }
  state.clarifications.push(...answers.map(({ question, answer }) => ({ question: question.question, answer })));
  for (const item of answers) {
    if (item.question.id === "JURISDICTION") {
      state.project.jurisdictions = item.answer.split(/,|;|\band\b/i).map((part) => part.trim()).filter(Boolean);
    }
    appendMessage("user", `${item.question.question}\nAnswer: ${item.answer}`);
  }
  state.pipeline = null;
  await runPipeline();
}
async function reviseAnalysis() {
  const input = q("revisionRequest");
  const answer = input?.value.trim();
  if (!answer) {
    alert("Describe the requested changes before rerunning the analysis.");
    return;
  }
  const question = "What changes did the project owner request?";
  state.clarifications.push({ question, answer });
  appendMessage("user", `${question}\nAnswer: ${answer}`);
  state.pipeline = null;
  state.archiveId = null;
  state.archiveError = "";
  state.tab = "Requirements";
  await runPipeline();
}
async function archiveCompletedAnalysis() {
  try {
    const saved = await post("/api/analyses", {
      id: makeId(),
      title: `${state.project.title || "Project analysis"} — ${new Date().toLocaleDateString()}`,
      project: state.project,
      state: { conversation: state.conversation, clarifications: state.clarifications, sources: state.sources, pipeline: state.pipeline },
    });
    state.archiveId = saved.id;
    state.archiveError = "";
    await refreshHistory();
  } catch (error) {
    state.archiveError = `Analysis completed, but could not be saved automatically: ${error.message}`;
  }
}
async function saveAnalysisCopy() {
  if (!state.pipeline?.complete) return;
  const title = prompt("Name this analysis", state.project.title || "Project analysis");
  if (!title?.trim()) return;
  try {
    const saved = await post("/api/analyses", { id: makeId(), title, project: state.project, state: { conversation: state.conversation, clarifications: state.clarifications, sources: state.sources, pipeline: state.pipeline } });
    state.archiveId = saved.id;
    await refreshHistory();
    render();
  } catch (error) { alert(error.message); }
}
async function refreshHistory() {
  try {
    const records = await api("/api/analyses");
    q("historyList").innerHTML = records.length ? records.map((record) => `<article class="history-card"><span><strong>${escapeHtml(record.title)}</strong><br><span class="hint">${new Date(record.createdAt).toLocaleString()}</span></span><span class="history-actions"><button class="small-btn" data-open-analysis="${escapeHtml(record.id)}">Open</button><button class="small-btn" data-delete-analysis="${escapeHtml(record.id)}">Delete</button></span></article>`).join("") : `<span class="hint">No saved analyses.</span>`;
    const selector = q("projectSelector");
    if (selector) {
      selector.innerHTML = `<option value="">Current project</option>${records.map((record) => `<option value="${escapeHtml(record.id)}">${escapeHtml(record.title)}</option>`).join("")}`;
      selector.value = records.some((record) => record.id === state.archiveId) ? state.archiveId : "";
    }
    q("historyList").querySelectorAll("[data-open-analysis]").forEach((button) => button.onclick = () => openSavedAnalysis(button.dataset.openAnalysis));
    q("historyList").querySelectorAll("[data-delete-analysis]").forEach((button) => button.onclick = () => deleteAnalysis(button.dataset.deleteAnalysis));
  } catch (error) { q("historyList").textContent = error.message; }
}
async function openSavedAnalysis(id) {
  try {
    const record = await api(`/api/analyses/${encodeURIComponent(id)}`);
    const saved = record.payload;
    state.project = saved.project || { title: saved.useCase?.name || record.use_case_name || "", description: "", jurisdictions: [] };
    state.conversation = saved.conversation || [];
    state.clarifications = Array.isArray(saved.clarifications) ? saved.clarifications : clarificationsFromConversation(state.conversation);
    state.sources = saved.sources || [];
    state.pipeline = saved.pipeline;
    state.archiveId = record.id;
    state.tab = "Inputs & clarifications";
    state.page = "Overview";
    syncBriefInputs();
    render();
  } catch (error) { alert(error.message); }
}
async function deleteAnalysis(id) {
  if (!confirm("Delete this saved analysis?")) return;
  try {
    await api(`/api/analyses/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.archiveId === id) {
      state.archiveId = null; state.pipeline = null; state.project = { title: "", description: "", jurisdictions: [] }; state.conversation = []; state.clarifications = []; state.sources = [];
      syncBriefInputs(); render();
    }
    await refreshHistory();
  } catch (error) { alert(error.message); }
}
async function updateApproval(requirementId, status) {
  if (!state.archiveId) return;
  try {
    const payload = await post(`/api/analyses/${encodeURIComponent(state.archiveId)}/approval`, { requirementId, status, note: "" });
    state.pipeline = payload.pipeline;
    if (requirementId === "__analysis__" && status === "changes_requested") {
      state.tab = "Inputs & clarifications";
      state.page = "Chat";
    }
    render();
  } catch (error) { alert(error.message); }
}
async function downloadSrs() {
  if (!state.archiveId) { alert("Save the completed analysis before downloading its SRS."); return; }
  try {
    const response = await fetch(`/api/analyses/${encodeURIComponent(state.archiveId)}/srs.pdf`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Could not download the SRS.");
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(state.project.title || "FinAssistant-SRS").replace(/[^a-z0-9-_]+/gi, "-")}.pdf`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) { alert(error.message); }
}
function renderAuthMode() {
  const registering = authMode === "register";
  q("authTitle").textContent = registering ? "Create your FinAssistant account" : "Sign in to FinAssistant";
  q("authSubmit").textContent = registering ? "Create account" : "Sign in";
  q("authPassword").autocomplete = registering ? "new-password" : "current-password";
  q("authPassword").minLength = registering ? 10 : 1;
  q("authUsernameRow").hidden = !registering;
  q("authUsername").required = registering;
  q("authIdentityLabel").textContent = registering ? "Email" : "Username or email";
  q("authEmail").type = registering ? "email" : "text";
  q("authEmail").name = registering ? "email" : "identity";
  q("authEmail").autocomplete = registering ? "email" : "username";
  q("authToggle").textContent = registering ? "Already have an account? Sign in" : "Create an account";
  q("authError").textContent = "";
}
function lockWorkspace() {
  state.user = null; state.project = { title: "", description: "", jurisdictions: [] }; state.conversation = []; state.clarifications = []; state.sources = []; state.pipeline = null; state.archiveId = null;
  state.page = "Overview";
  state.notice = "";
  document.body.classList.remove("authenticated");
}
async function initializeWorkspace(user) {
  state.user = user;
  state.project = { title: "", description: "", jurisdictions: [] };
  state.conversation = [];
  state.clarifications = [];
  state.sources = [];
  state.pipeline = null;
  state.page = "Overview";
  state.tab = "Requirements";
  state.archiveId = null;
  state.notice = "";
  state.archiveError = "";
  document.body.classList.add("authenticated");
  q("accountMenuToggle").textContent = (user.username || user.email).trim().charAt(0).toUpperCase();
  q("accountEmail").textContent = user.email;
  syncBriefInputs();
  render(); renderSourceList();
  try { await persistState(); }
  catch (error) { console.error("Could not clear the previous unfinished workspace:", error); }
  await refreshHistory();
}
function wireGlobal() {
  initializeTheme();
  q("themeToggle").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  q("accountMenuToggle").onclick = () => setAccountMenu(q("accountPopover").hidden);
  document.addEventListener("click", (event) => { if (!event.target.closest(".account-menu")) setAccountMenu(false); });
  q("authToggle").onclick = () => { authMode = authMode === "login" ? "register" : "login"; renderAuthMode(); };
  q("authForm").onsubmit = async (event) => {
    event.preventDefault(); q("authSubmit").disabled = true;
    try {
      const credentials = authMode === "register"
        ? { email: q("authEmail").value, username: q("authUsername").value, password: q("authPassword").value }
        : { username: q("authEmail").value, password: q("authPassword").value };
      const user = await post(`/api/auth/${authMode}`, credentials);
      q("authPassword").value = "";
      await initializeWorkspace(user);
    } catch (error) { q("authError").textContent = error.message; }
    finally { q("authSubmit").disabled = false; }
  };
  q("signOutBtn").onclick = async () => {
    try { await post("/api/auth/logout", {}); lockWorkspace(); }
    catch (error) { alert(error.message); }
  };
  document.querySelectorAll(".sidebar-nav [data-page]").forEach((button) => {
    button.onclick = async () => {
      state.page = button.dataset.page;
      if (state.page === "Knowledge Base" && !state.kbCache) {
        try { state.kbCache = await api("/api/kb"); }
        catch (error) { state.notice = `Could not load the knowledge base: ${error.message}`; }
      }
      render();
    };
  });
  q("newProjectTop").onclick = () => {
    state.project = { title: "", description: "", jurisdictions: [] };
    state.conversation = []; state.clarifications = []; state.sources = []; state.pipeline = null; state.archiveId = null;
    state.page = "Chat"; state.tab = "Requirements"; state.notice = "";
    syncBriefInputs(); render(); schedulePersistence();
  };
  q("projectSelector").onchange = (event) => {
    if (event.target.value) openSavedAnalysis(event.target.value);
    else if (state.archiveId) {
      state.archiveId = null;
      state.pipeline = null;
      state.project = { title: "", description: "", jurisdictions: [] };
      state.conversation = []; state.clarifications = []; state.sources = [];
      state.page = "Overview";
      syncBriefInputs(); render();
    }
  };
}
async function initialize() {
  wireGlobal(); renderAuthMode();
  try {
    const response = await fetch("/api/auth/me");
    const result = await response.json();
    if (result.data) await initializeWorkspace(result.data);
  } catch (error) { q("authError").textContent = "Could not connect to the server."; }
}
window.addEventListener("pagehide", () => {
  if (!state.user) return;
  navigator.sendBeacon("/api/state", new Blob([JSON.stringify(persistableState())], { type: "application/json" }));
});
initialize();
