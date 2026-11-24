// tests/e2e.js — drives the real UI against the real server (with Google AI mocked by tests/mock-google.js).
// Requires Playwright to be installed (`npm i -D playwright`); it is not needed to run the app itself.
// Usage: node tests/e2e.js [screenshotDir]

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const PORT = 3111;
const ROOT = path.join(__dirname, "..");
const SHOTS = process.argv[2] || null;
const LOG = path.join(os.tmpdir(), "finreq-mock-log.jsonl");
const CACHE = path.join(os.tmpdir(), "finreq-mock-cache.json");
const DB = path.join(os.tmpdir(), "finreq-mock-state.sqlite");
for (const f of [LOG, CACHE, DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failed++;
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true }); };

(async () => {
  const server = spawn("node", ["-r", "./tests/mock-google.js", "server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT, GOOGLE_API_KEY: "mock-google-key", MOCK_LOG: LOG, KB_CACHE_PATH: CACHE, FINREQ_DB_PATH: DB, FINREQ_DATA_PATH: path.join(os.tmpdir(), "finreq-e2e-no-legacy.json") },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const jsErrors = [];
    page.on("pageerror", (e) => jsErrors.push(e.message));
    await page.goto(`http://localhost:${PORT}/`);

    const anonymousStatuses = await page.evaluate(async () => {
      const state = await fetch("/api/state");
      const analyses = await fetch("/api/analyses");
      return [state.status, analyses.status];
    });
    check("workspace and analyses APIs reject anonymous access", anonymousStatuses[0] === 401 && anonymousStatuses[1] === 401);
    await page.click("#authToggle");
    await page.fill("#authUsername", "Alice");
    await page.fill("#authEmail", "alice@example.test");
    await page.fill("#authPassword", "a-long-test-password");
    await page.click("#authSubmit");
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    check("new account is represented by its capitalized username initial", (await page.locator("#accountMenuToggle").textContent()) === "A" && await page.locator("#accountPopover").isHidden());
    check("theme toggle is immediately to the left of the profile button", await page.locator("#themeToggle").evaluate(el=>el.getBoundingClientRect().right<document.querySelector("#accountMenuToggle").getBoundingClientRect().left));
    await page.click("#themeToggle");
    check("theme toggle switches to dark mode and persists the preference", await page.locator("html").getAttribute("data-theme")==="dark" && await page.evaluate(()=>localStorage.getItem("finassistant-theme"))==="dark" && (await page.locator("#themeToggle").getAttribute("aria-label"))==="Switch to light mode");
    await page.click("#themeToggle");
    check("theme toggle switches back to light mode", await page.locator("html").getAttribute("data-theme")==="light" && await page.evaluate(()=>localStorage.getItem("finassistant-theme"))==="light");
    await page.click("#accountMenuToggle");
    check("account menu reveals the user's email and logout option", await page.locator("#accountPopover").isVisible() && (await page.locator("#accountEmail").textContent()) === "alice@example.test" && (await page.locator("#signOutBtn").textContent()) === "Log out");
    await page.keyboard.press("Escape");
    check("Escape closes account menu and returns focus to its icon", await page.locator("#accountPopover").isHidden() && await page.locator("#accountMenuToggle").evaluate(el=>el===document.activeElement));
    check("new workspace shows workflow and shared deliverables before step one and use-case previews", (await page.locator(".uc-btn").count()) === 8 && await page.locator(".uc-card-desc").count() === 8 && await page.locator("#sharedProjectInfo").isVisible() && await page.locator("#sharedProjectInfo .preview-card").count() === 5 && await page.locator("#sharedProjectInfo").evaluate(el=>el.getBoundingClientRect().bottom<document.querySelector("#flowProgress").getBoundingClientRect().top) && await page.locator(".workflow-heading").innerText().then(text=>text==="How FinAssistant works") && await page.locator(".how-it-works").evaluate(el=>el.getBoundingClientRect().bottom<document.querySelector(".what-you-get-heading").getBoundingClientRect().top) && await page.locator(".how-step .step-title").first().innerText().then(text=>text==="Have real interviews") && await page.locator("#interviewOptions").isHidden() && await page.locator("#changeUseCase").isHidden());
    await page.evaluate(async () => fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, selected: "payment", formRole: "audit" }),
    }));
    await page.click("#accountMenuToggle");
    await page.click("#signOutBtn");
    await page.waitForFunction(() => !document.body.classList.contains("authenticated"));
    await page.click("#authToggle");
    await page.fill("#authUsername", "Bob");
    await page.fill("#authEmail", "bob@example.test");
    await page.fill("#authPassword", "another-long-test-password");
    await page.click("#authSubmit");
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    const bobData = await page.evaluate(async () => {
      const [state, analyses] = await Promise.all([fetch("/api/state"), fetch("/api/analyses")]);
      return [await state.json(), await analyses.json()];
    });
    check("second account cannot see the first account's workspace or analyses", bobData[0].data.privateMarker === undefined && bobData[1].data.length === 0);
    await page.click("#accountMenuToggle");
    await page.click("#signOutBtn");
    await page.waitForFunction(() => !document.body.classList.contains("authenticated"));
    await page.fill("#authEmail", "Alice");
    await page.fill("#authPassword", "a-long-test-password");
    await page.click("#authSubmit");
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    const aliceMarker = await page.evaluate(async () => (await (await fetch("/api/state")).json()).data.formRole);
    check("signing back in restores the original account's workspace", aliceMarker === "audit");
    await page.evaluate(async () => fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    }));

    // --- Use-case preview and adaptive interview ----------------------------
    await page.click('button.uc-btn:has-text("Payment Processing")');
    check("use-case cards show their summaries and selection does not advance", await page.locator("#caseChooser").isVisible() && await page.locator("#interviewOptions").isHidden() && (await page.locator('button.uc-btn[data-uc="payment"]').textContent()).includes("cross-border payments") && await page.locator("#continueUseCaseBtn").isEnabled());
    await page.click("#continueUseCaseBtn");
    check("selected use case and change action are grouped outside the interview panel", await page.locator("#caseChooser").isHidden() && await page.locator("#sharedProjectInfo").isHidden() && await page.locator("#changeUseCase").isVisible() && await page.locator("#changeUseCase").evaluate(el=>!el.closest(".panel") && el.nextElementSibling.matches(".panel.side") && el.contains(document.querySelector("#selectedUseCaseName")) && el.contains(document.querySelector("#backToCasesBtn"))) && await page.locator("#interviewOptions").isVisible() && await page.locator("#selectedUseCaseName").innerText().then(text=>text==="Payment Processing") && (await page.locator(".role-btn").count()) === 9);
    check("default stakeholder briefing is role-specific and avoids repeating the use-case preview", await page.locator("#content .role-briefing h2").innerText().then(text=>text==="Customers & end users") && (await page.locator("#content .briefing-section").count())===2 && await page.locator("#content .role-briefing").innerText().then(text=>!text.includes("Payment Processing")&&!text.includes("cross-border payments")));
    await page.click('.role-btn:has-text("Business analysts")');
    check("changing stakeholder updates the briefing topics and preparation guidance", await page.locator("#content .role-briefing h2").innerText().then(text=>text==="Business analysts") && await page.locator("#content .briefing-section").first().innerText().then(text=>text.includes("Business objective and success measures")) && await page.locator("#content .briefing-section").last().innerText().then(text=>text.includes("Current process notes or a workflow sketch")));
    await page.click("#backToCasesBtn");
    check("back returns to the previews with the current choice selected", await page.locator("#caseChooser").isVisible() && (await page.locator('button.uc-btn[data-uc="payment"]').getAttribute("aria-pressed")) === "true");
    await page.click('button.uc-btn:has-text("Digital & Mobile Banking")');
    await page.click("#continueUseCaseBtn");
    const secondStepText = await page.locator("main").innerText();
    check("second step groups selected case and change action outside the panel", (await page.locator("#flowProgress").textContent()) === "STEP 2 OF 2 · INTERVIEWS & ANALYSIS" && secondStepText.includes("Digital & Mobile Banking") && await page.locator("#selectedUseCaseName").innerText().then(text=>text==="Digital & Mobile Banking") && await page.locator("#changeUseCase").evaluate(el=>!el.closest(".panel") && el.nextElementSibling.matches(".panel.side") && el.contains(document.querySelector("#backToCasesBtn"))));
    await page.click("#backToCasesBtn");
    await page.click('button.uc-btn:has-text("Payment Processing")');
    await page.click("#continueUseCaseBtn");
    await page.click('.role-btn:has-text("Business analysts")');
    await page.click("#startIvBtn");
    await page.waitForSelector(".msg.agent .msg-bubble:not(.thinking)");
    check("interview opens with an agent-generated question", (await page.locator(".msg.agent").first().textContent()).includes("business objective"));

    const answer = async (text) => {
      const before = await page.locator(".msg.agent").count();
      await page.fill("#chatInput", text);
      await page.click("#sendBtn");
      await page.waitForFunction((n) => document.querySelectorAll(".msg.agent").length > n && !document.querySelector(".msg-bubble.thinking"), before);
    };
    await answer("Make payments quick and reliable.");
    check("agent follows up on a vague answer", (await page.locator(".msg.agent").last().textContent()).includes("put a number on that"));
    await answer("Under two seconds for domestic transfers.");
    await answer("Biometric step-up above a risk threshold.");
    check("agent signals completion and offers Save", (await page.locator("#saveIvBtn").count()) === 1);
    await shot(page, "01-interview-complete");
    await page.click("#saveIvBtn");
    check("saved interview appears as a chip", (await page.locator("#ivList .chip").count()) === 1);
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    check("normal refresh restores the current interview page and its draft", await page.locator("#interviewOptions").isVisible() && (await page.locator("#ivList .chip").count()) === 1 && (await page.locator(".role-btn.active").textContent()).includes("Business analysts"));
    await page.click("#backToCasesBtn");
    await page.click('button.uc-btn:has-text("Digital & Mobile Banking")');
    await page.click("#continueUseCaseBtn");
    await page.evaluate(() => persistState());
    const switchedWorkspace = await page.evaluate(async () => (await (await fetch("/api/state")).json()).data);
    check("switching use cases discards the previous unanalysed interviews and sources", switchedWorkspace.selected === "banking" && (!switchedWorkspace.interviews || switchedWorkspace.interviews.length === 0) && (!switchedWorkspace.sources || switchedWorkspace.sources.length === 0));
    await page.click("#backToCasesBtn");
    await page.click('button.uc-btn:has-text("Payment Processing")');
    await page.click("#continueUseCaseBtn");
    await page.click('.role-btn:has-text("Business analysts")');
    await page.click("#startIvBtn");
    await page.waitForSelector(".msg.agent .msg-bubble:not(.thinking)");
    for (const text of ["Make payments quick and reliable.", "Under two seconds for domestic transfers.", "Biometric step-up above a risk threshold."]) {
      await page.fill("#chatInput", text);
      await page.click("#sendBtn");
      if (text.startsWith("Biometric")) await page.waitForSelector("#saveIvBtn");
      else await page.waitForFunction(() => !document.querySelector(".msg-bubble.thinking") && !document.querySelector("#sendBtn")?.disabled);
    }
    await page.click("#saveIvBtn");
    check("interviews for the active use case remain available after intentional case switching", (await page.locator("#ivList .chip").count()) === 1);

    // --- Input source masking ----------------------------------------------
    await page.click("summary");
    await page.selectOption("#srcType", "Incident report or audit finding");
    await page.fill("#srcText", "Card 4485 1234 5678 9012 duplicated. Contact jane.doe@examplebank.com, PIN: 4821.");
    await page.click("#addSrcBtn");
    check("sensitive fields masked before use", (await page.locator("#srcBadge .badge.warn").count()) === 1);
    const preview = await page.locator(".src-item .prev").textContent();
    check("raw card number and PIN are gone from stored source", !preview.includes("4485 1234") && !preview.includes("4821") && preview.includes("9012"));

    // --- Pipeline with clarification gate ----------------------------------
    await page.click("#runBtn");
    await page.waitForSelector(".clarify-panel");
    check("pipeline pauses at the clarification gate", (await page.locator(".stage-item.waiting").count()) === 1);
    check("clarification question is specific", (await page.locator(".clarify-q").textContent()).includes("latency"));
    await shot(page, "02-clarification-gate");
    await page.fill("[data-clq='0']", "p95 under 2 seconds");
    await page.click("#submitClarifyBtn");
    await page.waitForSelector(".tabs", { timeout: 15000 });
    check("all 7 stages complete", (await page.locator(".stage-item.done").count()) === 7);

    // --- Results ------------------------------------------------------------
    check("4 requirements extracted", (await page.locator("tbody tr").count()) === 4);
    check("clarification answer merged into the requirement", (await page.locator("tbody").textContent()).includes("p95 under 2 seconds"));
    check("low-confidence requirement auto-escalated", (await page.locator(".badge-review").count()) >= 1);
    await shot(page, "03-requirements");

    await page.click('.tab:has-text("Compliance")');
    const chips = await page.locator(".evidence-chip").allTextContents();
    check("compliance rows carry KB citation chips", chips.length >= 1 && chips.every((c) => /^[A-Z]+-\d{3}$/.test(c)), JSON.stringify(chips));
    check("derived security requirement carries its own citation chip", (await page.locator(".derived-item .evidence-chip").count()) >= 1);
    await shot(page, "04-compliance");

    await page.click('.tab:has-text("Conflicts")');
    check("conflict detected and shown", (await page.locator(".conflict-item").count()) === 1);

    await page.click('.tab:has-text("SDLC recommendation")');
    check("6 SDLC candidates, top marked Recommended", (await page.locator(".sdlc-card").count()) === 6 && (await page.locator(".rec").count()) === 1);
    check("SDLC candidates cite SDLC rules", (await page.locator(".sdlc-card .evidence-chip").allTextContents()).some((c) => c.startsWith("SDLC-")));
    await shot(page, "05-sdlc");

    await page.click('.tab:has-text("Traceability")');
    check("traceability row per requirement", (await page.locator("tbody tr").count()) === 4);

    await page.click('.tab:has-text("Knowledge base")');
    await page.waitForSelector(".kb-item");
    check("knowledge base browser lists all 37 items", (await page.locator(".kb-item").count()) === 37);
    await page.click('.kb-filter:has-text("regulation")');
    check("KB category filter works", (await page.locator(".kb-item").count()) === 7);

    // --- Retrieval really fed each agent -----------------------------------
    const log = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const idsFor = (agent) => log.filter((l) => l.agent === agent).flatMap((l) => l.evidenceIds);
    check("Clarification agent received REQ- guideline evidence", idsFor("clarify").some((i) => i.startsWith("REQ-")));
    check("Compliance agent received REG-/SEC- evidence", idsFor("compliance").some((i) => /^(REG|SEC)-/.test(i)));
    check("SDLC agent received SDLC- rule evidence", idsFor("sdlc").some((i) => i.startsWith("SDLC-")));
    check("Documentation agent received TPL- template evidence", idsFor("document").some((i) => i.startsWith("TPL-")));
    check("Every agent ran (interview + 7 pipeline calls)", ["interview", "extract", "clarify", "classify", "compliance", "risk", "sdlc", "document"].every((a) => log.some((l) => l.agent === a)));

    const archivedAnalyses = await page.evaluate(async () => (await (await fetch("/api/analyses")).json()).data);
    check("completed analysis and its inputs are archived automatically", archivedAnalyses.length === 1 && archivedAnalyses[0].useCaseId === "payment");
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    await page.waitForSelector(".tabs");
    check("normal refresh restores the completed analysis page and its results", await page.locator("#interviewOptions").isVisible() && (await page.locator(".stage-item.done").count()) === 7 && (await page.locator("#ivList .chip").count()) === 1);
    await page.route("**/api/pipeline/extract", (route) => route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Resource exhausted. Daily quota exceeded.", code: "upstream" }),
    }));
    await page.click("#runBtn");
    await page.waitForFunction(() => document.querySelector("#hint").textContent.includes("Draft interviews and input sources were discarded."));
    const failedRunState = await page.evaluate(async () => {
      const [workspace, analyses] = await Promise.all([fetch("/api/state"), fetch("/api/analyses")]);
      return [await workspace.json(), (await analyses.json()).data];
    });
    check("quota failure clears current interviews and partial results without deleting completed archive", (await page.locator("#ivList .chip").count()) === 0 && await page.locator(".workspace-start").count() === 1 && !("interviews" in failedRunState[0].data) && failedRunState[1].length === 1);
    await page.unroute("**/api/pipeline/extract");
    check("no JavaScript errors in the browser", jsErrors.length === 0, jsErrors.join("; "));
  } catch (e) {
    console.log("FAIL  test crashed: " + e.message);
    failed++;
  } finally {
    await browser.close();
    server.kill();
    for (const f of [LOG, CACHE, DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
