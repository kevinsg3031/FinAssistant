// Browser-level test for the description-first flow and all coordinated analysis stages.
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "finreq-e2e-"));
const logPath = path.join(tempDir, "mock-log.jsonl");
const dbPath = path.join(tempDir, "state.sqlite");
let server;
let failed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failed += 1;
};

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/auth/me`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The test server did not become ready.");
}

(async () => {
  let browser;
  let page;
  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["-r", "./tests/mock-google.js", "server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        GOOGLE_API_KEY: "mock-test-key",
        FINREQ_DB_PATH: dbPath,
        KB_CACHE_PATH: path.join(tempDir, "kb-cache.json"),
        MOCK_LOG: logPath,
      },
      stdio: "ignore",
    });
    await waitForServer(baseUrl);
    const staticResponse = await fetch(`${baseUrl}/app.js`);
    check("browser JavaScript is never served from a stale cache", staticResponse.headers.get("cache-control") === "no-store");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto(baseUrl);
    await page.locator("#authToggle").click();
    await page.locator("#authEmail").fill("demo@example.test");
    await page.locator("#authUsername").fill("Demo");
    await page.locator("#authPassword").fill("a-strong-test-password");
    await page.locator("#authForm").evaluate((form) => form.requestSubmit());
    await page.locator(".sidebar-nav [data-page='Chat']").waitFor();
    await page.locator(".sidebar-nav [data-page='Chat']").click();
    const sidebarText = await page.locator(".app-sidebar").innerText();
    check("sidebar contains project and saved analyses without source option or footer", sidebarText.includes("PROJECT") && sidebarText.includes("SAVED ANALYSES") && !sidebarText.includes("Supporting text") && !sidebarText.includes("Private workspace"));
    check("chat page uses concise project-focused labels", (await page.locator("#content").innerText()).includes("Project Chat") && await page.locator("#startProjectBtn").innerText() === "Start chat");
    check("empty chat does not show a welcome bubble below the brief", await page.locator("#projectChat .chat-message").count() === 0);
    await page.locator("#startProjectBtn").waitFor();

    await page.evaluate(async () => {
      await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 3,
          phase: "analysis",
          project: { title: "Unfinished old project", description: "This should be discarded on reopen.", jurisdictions: [] },
          conversation: [{ speaker: "user", text: "Old unfinished conversation" }],
          sources: [{ id: "old-source", title: "Old source", text: "Old unfinished source" }],
          pipeline: { stageStatus: { extract: "active" } },
        }),
      });
    });
    await page.reload();
    await page.locator(".sidebar-nav [data-page='Chat']").waitFor();
    await page.locator(".sidebar-nav [data-page='Chat']").click();
    await page.locator("#startProjectBtn").waitFor();
    const workspaceAfterFreshOpen = await page.evaluate(async () => (await (await fetch("/api/state")).json()).data);
    check("reopening the URL discards unfinished project state", await page.locator("#projectTitle").inputValue() === "" && await page.locator("#projectDescription").inputValue() === "" && !(await page.locator("#content").innerText()).includes("Old unfinished conversation") && workspaceAfterFreshOpen.conversation.length === 0 && !workspaceAfterFreshOpen.pipeline);

    await page.locator("#projectTitle").fill("Canada payments");
    await page.locator("#projectDescription").fill("Build a digital banking system for customers in Canada to initiate domestic payment transfers. The system should be fast and record every payment decision for audit. Contact operations@example.test for questions.");
    await page.locator(".chat-sources summary").click();
    await page.locator("#sourceTitle").fill("Internal policy excerpt from operations@example.test");
    await page.locator("#sourceText").fill("Payment decisions require review. Contact operations@example.test; sample account 1234567890123456.");
    await page.locator("#addSourceBtn").click();
    check("pasted source is masked before being shown or stored", (await page.locator("#sourceList").innerText()).includes("[EMAIL REDACTED]") && !(await page.locator("#sourceList").innerText()).includes("1234567890123456"));

    await page.locator("#startProjectBtn").click();
    check("project brief is masked before remaining in the workspace form", !(await page.locator("#projectDescription").inputValue()).includes("operations@example.test"));
    await page.locator(".chat-message.assistant").first().waitFor();
    const discoveryPrompt = await page.locator(".chat-message.assistant").first().innerText();
    check("starting from a project brief does not trigger an unnecessary questionnaire", discoveryPrompt.includes("start the analysis") && discoveryPrompt.includes("TBD") && !/identity verification|legacy banking|payment rail/i.test(discoveryPrompt));
    await page.locator("#chatInput").fill("Payment completion should take no more than two seconds. The system will operate in Canada.");
    await page.locator("#chatForm").evaluate((form) => form.requestSubmit());
    await page.locator(".chat-message.assistant").nth(1).waitFor();
    await page.locator("#runAnalysis").waitFor();
    await page.locator("#runAnalysis").click();
    await page.locator(".clarify-panel").waitFor({ timeout: 30000 });
    check("agentic analysis pauses for a material clarification", await page.locator(".clarify-panel").isVisible());
    check("clarification blockers are asked together as one batch", await page.locator("[data-clarification]").count() === 2);
    await page.locator("[data-clarification='0']").fill("No more than two seconds for payment completion.");
    await page.locator("[data-clarification='1']").fill("Keep partner selection open; TBD.");
    await page.locator("#submitClarifications").click();
    await page.locator(".overview-dashboard").waitFor({ timeout: 60000 });
    await page.locator("#saveAnalysisCopy").waitFor({ timeout: 30000 });
    await page.locator(".sidebar-nav [data-page='Requirements']").click();
    check("pipeline completes and produces classified functional/non-functional requirements", (await page.locator("#content").innerText()).includes("FR-001") && (await page.locator("#content").innerText()).includes("NFR-001"));
    await page.locator(".sidebar-nav [data-page='SRS Documentation']").click();
    check("documentation navigation opens the structured SRS", (await page.locator("#content").innerText()).includes("Software Requirements Specification"));
    await page.locator(".sidebar-nav [data-page='SDLC & Workflow']").click();
    check("SDLC navigation renders the recommended model and workflow", (await page.locator("#content").innerText()).includes("Recommended:"));
    await page.locator(".sidebar-nav [data-page='Quality, Compliance & Risk']").click();
    await page.locator(".quality-subnav [data-tab='Compliance']").click();
    check("compliance mappings show retrieved knowledge-base citations", await page.locator("#content .evidence-chip").count() > 0);
    await page.locator(".sidebar-nav [data-page='Knowledge Base']").click();
    check("knowledge base omits the intro tagline and capitalizes category labels", await page.locator("#content .step-desc").count() === 0 && await page.locator("[data-kb='security-standard']").innerText().then((text) => text.startsWith("Security Standard")));

    const archive = await page.evaluate(async () => (await (await fetch("/api/analyses")).json()).data[0]);
    const pdf = await page.evaluate(async (id) => {
      const response = await fetch(`/api/analyses/${encodeURIComponent(id)}/srs.pdf`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get("content-type"), signature: String.fromCharCode(...bytes.slice(0, 5)) };
    }, archive.id);
    check("completed analysis downloads as a PDF document", pdf.status === 200 && pdf.type === "application/pdf" && pdf.signature === "%PDF-", JSON.stringify(pdf));

    await page.locator(".sidebar-nav [data-page='Requirements']").click();
    for (const id of ["FR-001", "NFR-001", "NFR-002"]) {
      const review = page.locator(`[data-review='${id}|approved']`);
      if (await review.count()) {
        const approvalResponse = page.waitForResponse((response) =>
          response.url().includes("/approval") && response.request().postDataJSON()?.requirementId === id);
        await review.first().click();
        await approvalResponse;
      }
    }
    await page.locator(".sidebar-nav [data-page='Overview']").click();
    const changesResponse = page.waitForResponse((response) =>
      response.url().includes("/approval") && response.request().postDataJSON()?.status === "changes_requested");
    await page.locator('[data-owner-approval="changes_requested"]').click();
    await changesResponse;
    check("requesting changes returns to clarification inputs", (await page.locator("#content").innerText()).includes("Clarification requested by the project owner") && await page.locator("#revisionRequest").count() === 1);
    await page.locator("#revisionRequest").fill("Clarify that the partner API is responsible for executing the transfer; the platform only tracks and reconciles status.");
    await page.locator("#reviseAnalysis").click();
    await page.locator(".overview-dashboard").waitFor({ timeout: 60000 });
    const revisedArchive = await page.evaluate(async () => (await (await fetch("/api/analyses")).json()).data[0]);
    check("requested changes rerun and save as a separate completed analysis", revisedArchive.id !== archive.id);

    await page.locator(".sidebar-nav [data-page='Requirements']").click();
    for (const id of ["FR-001", "NFR-001", "NFR-002"]) {
      const review = page.locator(`[data-review='${id}|approved']`);
      if (await review.count()) {
        const approvalResponse = page.waitForResponse((response) =>
          response.url().includes("/approval") && response.request().postDataJSON()?.requirementId === id);
        await review.first().click();
        await approvalResponse;
      }
    }
    await page.locator(".sidebar-nav [data-page='Overview']").click();
    await page.locator("[data-owner-approval='approved']").click();
    await page.locator(".approval-banner").waitFor({ state: "detached" });
    check("owner review banner disappears after analysis approval", await page.locator(".approval-banner").count() === 0);
    await page.locator(".sidebar-nav [data-page='Quality, Compliance & Risk']").click();
    await page.locator(".quality-subnav [data-tab='Audit trail']").click();
    check("owner approval is retained in the audit trail", (await page.locator("#content").innerText()).includes("owner-approval"));
    await page.reload();
    await page.locator(".sidebar-nav [data-page='Chat']").waitFor({ timeout: 30000 });
    await page.locator("#historyList").getByText(/Canada payments/).first().waitFor();
    check("reopening starts a blank workspace while completed analyses remain archived", !(await page.locator("#content").innerText()).includes("Old unfinished conversation") && await page.locator("#historyList").getByText(/Canada payments/).count() === 2);
    await page.locator(`[data-open-analysis="${archive.id}"]`).click();
    await page.locator(".sidebar-nav [data-page='Chat']").click();
    const savedInputs = await page.locator("#content").innerText();
    check("opening a saved analysis displays its original brief and clarification Q&A", savedInputs.includes("Build a digital banking system") && savedInputs.includes("What is a high-level acceptable payment-completion time") && savedInputs.includes("No more than two seconds for payment completion.") && savedInputs.includes("Keep partner selection open; TBD.") && await page.locator("[data-saved-clarification]").count() === 2);
    await page.locator(`[data-open-analysis="${revisedArchive.id}"]`).click();
    await page.locator(".sidebar-nav [data-page='Overview']").click();
    check("approved saved analysis remains approved without a review banner", await page.locator(".approval-banner").count() === 0);

    const log = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const agents = new Set(log.map((entry) => entry.agent));
    const expected = ["stakeholderInteraction", "requirementExtraction", "clarification", "classification", "conflictDetection", "compliance", "securityPrivacy", "riskAnalysis", "sdlcSelection", "documentation", "validation"];
    check("separate specialist model calls completed", expected.every((name) => agents.has(name)), [...agents].join(", "));
    check("compliance and SDLC calls received retrieved evidence IDs", ["compliance", "sdlcSelection"].every((name) => log.some((entry) => entry.agent === name && entry.evidenceIds.length > 0)));
    check("raw pasted email and account identifier never reached the model mock", !fs.readFileSync(logPath, "utf8").includes("operations@example.test") && !fs.readFileSync(logPath, "utf8").includes("1234567890123456"));

    await page.locator("#newProjectTop").click();
    await page.locator("#startProjectBtn").waitFor();
    await page.locator("#projectTitle").fill("Failed draft");
    await page.locator("#projectDescription").fill("Build a fictional transfer system for the extraction failure test.");
    await page.locator("#startProjectBtn").click();
    await page.locator(".chat-message.assistant").first().waitFor();
    await page.route("**/api/pipeline/analyze", (route) => route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ type: "stage", stage: { key: "extract", label: "Requirement extraction", status: "active", agent: "Requirement Extraction Agent" } })}\n\ndata: ${JSON.stringify({ type: "error", error: "Simulated extraction failure" })}\n\n`,
    }));
    await page.locator("#runAnalysis").click();
    await page.getByText(/Analysis failed and its project draft was discarded/).waitFor();
    const clearedChat = await page.locator("#projectChat .chat-message").allTextContents();
    check("failed analysis clears its project and conversation immediately", await page.locator("#projectTitle").inputValue() === "" && await page.locator("#projectDescription").inputValue() === "" && clearedChat.length === 0);
    await page.unroute("**/api/pipeline/analyze");
    await page.reload();
    await page.locator(".sidebar-nav [data-page='Chat']").waitFor();
    await page.locator(".sidebar-nav [data-page='Chat']").click();
    await page.locator("#startProjectBtn").waitFor();
    const reloadedChat = await page.locator("#projectChat .chat-message").allTextContents();
    check("failed analysis draft does not return after reopening the URL", await page.locator("#projectTitle").inputValue() === "" && await page.locator("#projectDescription").inputValue() === "" && reloadedChat.length === 0);
  } catch (error) {
    console.error(error);
    if (page) console.error("Page state:\n", await page.locator("#content").innerText().catch(() => "(unavailable)"));
    if (fs.existsSync(logPath)) console.error("Mock calls:\n", fs.readFileSync(logPath, "utf8"));
    failed += 1;
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      await new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill("SIGTERM");
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
