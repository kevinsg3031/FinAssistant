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
    await page.fill("#authEmail", "alice@example.test");
    await page.fill("#authPassword", "a-long-test-password");
    await page.click("#authSubmit");
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    check("new account can register and enters its private workspace", (await page.locator("#accountEmail").textContent()) === "alice@example.test");
    await page.evaluate(async () => fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, privateMarker: "alice-only" }),
    }));
    await page.click("#signOutBtn");
    await page.waitForFunction(() => !document.body.classList.contains("authenticated"));
    await page.click("#authToggle");
    await page.fill("#authEmail", "bob@example.test");
    await page.fill("#authPassword", "another-long-test-password");
    await page.click("#authSubmit");
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    const bobData = await page.evaluate(async () => {
      const [state, analyses] = await Promise.all([fetch("/api/state"), fetch("/api/analyses")]);
      return [await state.json(), await analyses.json()];
    });
    check("second account cannot see the first account's workspace or analyses", bobData[0].data.privateMarker === undefined && bobData[1].data.length === 0);
    await page.click("#signOutBtn");
    await page.waitForFunction(() => !document.body.classList.contains("authenticated"));
    await page.fill("#authEmail", "alice@example.test");
    await page.fill("#authPassword", "a-long-test-password");
    await page.click("#authSubmit");
    await page.waitForFunction(() => document.body.classList.contains("authenticated"));
    const aliceMarker = await page.evaluate(async () => (await (await fetch("/api/state")).json()).data.privateMarker);
    check("signing back in restores the original account's workspace", aliceMarker === "alice-only");
    await page.evaluate(async () => fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    }));

    // --- Adaptive interview -------------------------------------------------
    await page.click('button.uc-btn:has-text("Payment Processing")');
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
