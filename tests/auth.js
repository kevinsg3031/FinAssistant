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
    const anonymousAgent = await request("/api/interview/turn", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("anonymous requests cannot access workspace, analyses or agent APIs", anonymousState.status === 401 && anonymousAnalyses.status === 401 && anonymousAgent.status === 401);

    const aliceRegistration = await request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.test", password: "alice-long-password" }),
    });
    const aliceResult = await responseJson(aliceRegistration);
    aliceCookie = aliceRegistration.headers.get("set-cookie")?.split(";")[0];
    check("registration creates an account and HttpOnly session", aliceResult.status === 201 && aliceResult.body.data.email === "alice@example.test" && /HttpOnly/.test(aliceRegistration.headers.get("set-cookie") || ""));

    const aliceState = { version: 1, privateMarker: "alice workspace" };
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

    const bobRegistration = await request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.test", password: "bob-long-password" }),
    }, aliceCookie);
    bobCookie = bobRegistration.headers.get("set-cookie")?.split(";")[0];
    const bobState = await responseJson(await request("/api/state", {}, bobCookie));
    const bobAnalyses = await responseJson(await request("/api/analyses", {}, bobCookie));
    const crossUserRead = await request("/api/analyses/alice-analysis", {}, bobCookie);
    const crossUserDelete = await request("/api/analyses/alice-analysis", { method: "DELETE" }, bobCookie);
    check("new account starts empty and cannot read/delete another user's analysis", bobState.body.data.privateMarker === undefined && bobAnalyses.body.data.length === 0 && crossUserRead.status === 404 && crossUserDelete.status === 404);
    check("saved analysis belongs to its creator", savedResult.status === 201 && (await (await request("/api/analyses", {}, aliceCookie)).json()).data.length === 1);

    await request("/api/auth/logout", { method: "POST" }, aliceCookie);
    check("logout revokes its session", (await request("/api/state", {}, aliceCookie)).status === 401);
    const login = await request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ALICE@example.test", password: "alice-long-password" }),
    });
    aliceCookie = login.headers.get("set-cookie")?.split(";")[0];
    const restoredState = await responseJson(await request("/api/state", {}, aliceCookie));
    check("sign-in restores the account's workspace", login.status === 200 && restoredState.body.data.privateMarker === aliceState.privateMarker);
    const badLogin = await request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.test", password: "wrong-password" }),
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
