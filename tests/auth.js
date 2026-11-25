// Authenticated API integration checks; no browser or Google API access required.
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finreq-auth-test-"));
const dbPath = path.join(dir, "state.sqlite");
let server;
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failed++;
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

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 200) return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Server did not become ready.");
}

(async () => {
  let aliceCookie;
  let bobCookie;
  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), GOOGLE_API_KEY: "test-key", FINREQ_DB_PATH: dbPath },
      stdio: "ignore",
    });
    await waitForServer(baseUrl);

    const request = (route, options = {}, cookie = "") => fetch(`${baseUrl}${route}`, {
      ...options,
      headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) },
    });
    const responseJson = async (response) => ({ status: response.status, body: await response.json() });
    const anonymousState = await request("/api/state");
    const anonymousAnalyses = await request("/api/analyses");
    const anonymousAgent = await request("/api/project/turn", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const anonymousPipeline = await request("/api/pipeline/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const anonymousPdf = await request("/api/analyses/alice-analysis/srs.pdf");
    check("anonymous requests cannot access workspace, analyses or agent APIs", anonymousState.status === 401 && anonymousAnalyses.status === 401 && anonymousAgent.status === 401 && anonymousPipeline.status === 401 && anonymousPdf.status === 401);

    const aliceRegistration = await request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.test", username: "Alice", password: "alice-long-password" }),
    });
    const aliceResult = await responseJson(aliceRegistration);
    aliceCookie = aliceRegistration.headers.get("set-cookie")?.split(";")[0];
    const registrationCookie = aliceRegistration.headers.get("set-cookie") || "";
    check("registration creates a username and browser-session-only HttpOnly cookie", aliceResult.status === 201 && aliceResult.body.data.email === "alice@example.test" && aliceResult.body.data.username === "Alice" && /HttpOnly/.test(registrationCookie) && /SameSite=Strict/.test(registrationCookie) && !/Max-Age|Expires=/i.test(registrationCookie));
    const duplicateUsername = await request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice2@example.test", username: "alice", password: "another-long-password" }),
    });
    check("username uniqueness is case-insensitive", duplicateUsername.status === 400);

    const aliceState = { version: 2, selected: "payment", formRole: "audit" };
    await request("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(aliceState) }, aliceCookie);
    const savedAnalysis = await request("/api/analyses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "alice-analysis",
        title: "Alice's analysis",
        useCase: { id: "payment", name: "Payment Processing" },
        state: { pipeline: { complete: true }, interviews: [], sources: [] },
      }),
    }, aliceCookie);
    const savedResult = await responseJson(savedAnalysis);
    const pdfResponse = await request("/api/analyses/alice-analysis/srs.pdf", {}, aliceCookie);
    const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
    check("saved analysis exports a real PDF SRS", pdfResponse.status === 200 && pdfResponse.headers.get("content-type") === "application/pdf" && pdfBytes.subarray(0, 5).toString() === "%PDF-");
    const projectArchive = await request("/api/analyses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "alice-project-analysis",
        title: "Alice project analysis",
        project: { title: "Payment project", description: "Build payments", jurisdictions: ["Canada"] },
        state: { pipeline: { complete: true, approvalTasks: [{ requirementId: "FR-001", required: true, status: "pending" }], auditTrail: [] } },
      }),
    }, aliceCookie);
    const blockedApproval = await request("/api/analyses/alice-project-analysis/approval", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirementId: "__analysis__", status: "approved", note: "Reviewed" }),
    }, aliceCookie);
    const itemApproval = await request("/api/analyses/alice-project-analysis/approval", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirementId: "FR-001", status: "approved", note: "Reviewed" }),
    }, aliceCookie);
    const approvalResponse = await request("/api/analyses/alice-project-analysis/approval", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirementId: "__analysis__", status: "approved", note: "Reviewed" }),
    }, aliceCookie);
    const approvalResult = await approvalResponse.json();
    check("owner must resolve required item reviews before final approval", projectArchive.status === 201 && blockedApproval.status === 400 && itemApproval.status === 200 && approvalResponse.status === 200 && approvalResult.data.pipeline.auditTrail.at(-1).reviewer.username === "Alice");

    const bobRegistration = await request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.test", username: "Bob", password: "bob-long-password" }),
    }, aliceCookie);
    bobCookie = bobRegistration.headers.get("set-cookie")?.split(";")[0];
    const bobState = await responseJson(await request("/api/state", {}, bobCookie));
    const bobAnalyses = await responseJson(await request("/api/analyses", {}, bobCookie));
    const crossUserRead = await request("/api/analyses/alice-analysis", {}, bobCookie);
    const crossUserDelete = await request("/api/analyses/alice-analysis", { method: "DELETE" }, bobCookie);
    check("new account starts empty and cannot read/delete another user's analysis", Object.keys(bobState.body.data).length === 0 && bobAnalyses.body.data.length === 0 && crossUserRead.status === 404 && crossUserDelete.status === 404);
    check("saved analysis belongs to its creator", savedResult.status === 201 && (await (await request("/api/analyses", {}, aliceCookie)).json()).data.length === 2);

    await request("/api/auth/logout", { method: "POST" }, aliceCookie);
    check("logout revokes its session", (await request("/api/state", {}, aliceCookie)).status === 401);
    const login = await request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "aLiCe", password: "alice-long-password" }),
    });
    const loginResult = await login.json();
    aliceCookie = login.headers.get("set-cookie")?.split(";")[0];
    const restoredState = await responseJson(await request("/api/state", {}, aliceCookie));
    check("username sign-in restores the account's workspace", login.status === 200 && loginResult.data.username === "Alice" && restoredState.body.data.formRole === aliceState.formRole);
    const emailLogin = await request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ALICE@example.test", password: "alice-long-password" }),
    });
    check("email sign-in remains available for existing users", emailLogin.status === 200);
    const badLogin = await request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong-password" }),
    });
    check("incorrect credentials are rejected", badLogin.status === 401);
  } catch (error) {
    console.error(error);
    failed++;
  } finally {
    if (server && server.exitCode === null) {
      await new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill("SIGTERM");
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
