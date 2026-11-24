const http = require("http");
const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}
loadDotEnv();

const kb = require("./lib/kb");
const agents = require("./lib/agents");
const { GoogleAIError } = require("./lib/google");
const storage = require("./lib/storage");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GOOGLE_MODEL || "gemini-3.8-flash";
const API_KEY = process.env.GOOGLE_API_KEY || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const SESSION_COOKIE = "finreq_session";

// Every /api/pipeline/* route below is stateless: the client holds the running
// pipeline context (accumulated requirements, compliance, risks, etc.) and resends
// what each next agent needs. Requests use a server-side session only to identify
// the account; pipeline context is never shared or stored by these endpoints.

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function getSessionToken(req) {
  const cookie = req.headers.cookie || "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : "";
}
function getAuthenticatedUser(req, res) {
  const user = storage.getSessionUser(getSessionToken(req));
  if (user) return user;
  sendJson(res, 401, { ok: false, error: "Please sign in to continue.", code: "unauthorized" });
  return null;
}
function setSessionCookie(req, res, token) {
  const secure = req.socket.encrypted ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}
function requireKey(res) {
  if (API_KEY) return true;
  sendJson(res, 500, { ok: false, code: "auth", error: "The server has no GOOGLE_API_KEY configured. Add it to finreq-local/.env (see .env.example) or set it as an environment variable, then restart the server." });
  return false;
}
function route(handler, opts = {}) {
  return async (req, res) => {
    try {
      if (!getAuthenticatedUser(req, res)) return;
      if (!opts.skipKeyCheck && !requireKey(res)) return;
      const body = await readBody(req);
      const data = await handler(body);
      sendJson(res, 200, { ok: true, data });
    } catch (e) {
      if (e instanceof GoogleAIError) return sendJson(res, e.status || 500, { ok: false, error: e.message, code: e.code });
      sendJson(res, 500, { ok: false, error: e.message, code: "other" });
    }
  };
}
function resolveEvidence(ids) {
  if (!ids || !ids.length) return [];
  const all = kb.listAll();
  return ids.map((id) => all.find((i) => i.id === id)).filter(Boolean);
}

// --- Stakeholder Interaction Agent -----------------------------------------
const interviewTurn = route(async ({ useCase, roleLabel, transcript }) => agents.interviewTurn({ apiKey: API_KEY, model: MODEL, useCase, roleLabel, transcript: transcript || [] }));

// --- Requirement Extraction Agent ------------------------------------------
const pipelineExtract = route(async ({ useCase, interviews, sources }) => {
  if (!interviews || !interviews.length) throw new Error("At least one stakeholder interview is required.");
  return agents.extract({ apiKey: API_KEY, model: MODEL, useCase, interviews, sources: sources || [] });
});

// --- Clarification Agent ----------------------------------------------------
const pipelineClarifyCheck = route(async ({ useCase, requirements }) => agents.clarify({ apiKey: API_KEY, model: MODEL, useCase, requirements }));

// --- Classification + Conflict-Detection Agent ------------------------------
const pipelineClassify = route(async ({ useCase, requirements }) => agents.classifyAndDetectConflicts({ apiKey: API_KEY, model: MODEL, useCase, requirements }));

// --- Compliance + Security/Privacy Agent (RAG) ------------------------------
const pipelineCompliance = route(async ({ useCase, requirements }) => {
  const result = await agents.assessComplianceAndSecurity({ apiKey: API_KEY, model: MODEL, useCase, requirements });
  return {
    compliance: (result.compliance || []).map((c) => ({ ...c, evidence: resolveEvidence(c.citedEvidenceIds) })),
    derivedSecurityRequirements: (result.derivedSecurityRequirements || []).map((d) => ({ ...d, evidence: resolveEvidence(d.citedEvidenceIds) })),
  };
});

// --- Risk-Analysis Agent -----------------------------------------------------
const pipelineRisk = route(async ({ useCase, requirements, compliance }) => agents.assessRisk({ apiKey: API_KEY, model: MODEL, useCase, requirements, compliance }));

// --- SDLC-Selection Agent (RAG) ----------------------------------------------
const pipelineSdlc = route(async ({ useCase, requirements, risks }) => {
  const result = await agents.selectSDLC({ apiKey: API_KEY, model: MODEL, useCase, requirements, risks });
  return {
    candidates: (result.candidates || []).map((c) => ({ ...c, evidence: resolveEvidence(c.citedEvidenceIds) })),
    workflow: result.workflow || [],
  };
});

// --- Documentation + Validation Agent ---------------------------------------
const pipelineDocument = route(async ({ useCase, requirements, compliance, conflicts }) => agents.documentAndValidate({ apiKey: API_KEY, model: MODEL, useCase, requirements, compliance, conflicts }));

// --- Knowledge base (read-only browse; no API key needed, it's local metadata) ----
const listKB = route(async () => kb.listAll(), { skipKeyCheck: true });

function serveStatic(req, res) {
  let reqPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, path.normalize(reqPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

const ROUTES = {
  "/api/interview/turn": interviewTurn,
  "/api/pipeline/extract": pipelineExtract,
  "/api/pipeline/clarify-check": pipelineClarifyCheck,
  "/api/pipeline/classify": pipelineClassify,
  "/api/pipeline/compliance": pipelineCompliance,
  "/api/pipeline/risk": pipelineRisk,
  "/api/pipeline/sdlc": pipelineSdlc,
  "/api/pipeline/document": pipelineDocument,
};

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/auth/me") {
    const user = storage.getSessionUser(getSessionToken(req));
    return sendJson(res, 200, { ok: true, data: user ? { id: user.id, email: user.email, username: user.username } : null });
  }
  if (req.method === "POST" && (req.url === "/api/auth/register" || req.url === "/api/auth/login")) {
    readBody(req).then((body) => {
      let user;
      if (req.url === "/api/auth/register") {
        user = storage.createUser(body.email, body.username, body.password);
      } else {
        user = storage.authenticateUser(body.username || body.email, body.password);
        if (!user) {
          sendJson(res, 401, { ok: false, error: "Email or password is incorrect.", code: "invalid_credentials" });
          return;
        }
      }
      const session = storage.createSession(user.id);
      setSessionCookie(req, res, session.token);
      sendJson(res, req.url === "/api/auth/register" ? 201 : 200, { ok: true, data: { id: user.id, email: user.email, username: user.username } });
    }).catch((e) => {
      sendJson(res, 400, { ok: false, error: e.message || "Could not authenticate account.", code: "auth" });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/auth/logout") {
    storage.deleteSession(getSessionToken(req));
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true, data: { signedOut: true } });
  }
  if (req.method === "POST" && ROUTES[req.url]) return ROUTES[req.url](req, res);
  if (req.method === "GET" && req.url === "/api/state") {
    try {
      const user = getAuthenticatedUser(req, res);
      if (!user) return;
      return sendJson(res, 200, { ok: true, data: storage.loadState(user.id) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Could not load saved application data.", code: "storage" });
    }
  }
  if ((req.method === "PUT" || req.method === "POST") && req.url === "/api/state") {
    readBody(req).then((body) => {
      const user = getAuthenticatedUser(req, res);
      if (!user) return;
      storage.saveState(user.id, body);
      sendJson(res, 200, { ok: true, data: { saved: true } });
    }).catch((e) => {
      sendJson(res, 400, { ok: false, error: e.message || "Could not save application data.", code: "storage" });
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/analyses") {
    try {
      const user = getAuthenticatedUser(req, res);
      if (!user) return;
      return sendJson(res, 200, { ok: true, data: storage.listAnalyses(user.id) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Could not load saved analyses.", code: "storage" });
    }
  }
  if (req.method === "POST" && req.url === "/api/analyses") {
    readBody(req).then((body) => {
      const user = getAuthenticatedUser(req, res);
      if (!user) return;
      const analysis = storage.saveAnalysis(user.id, body);
      sendJson(res, 201, { ok: true, data: { id: analysis.id, title: analysis.title, useCaseId: analysis.use_case_id, useCaseName: analysis.use_case_name, createdAt: analysis.created_at } });
    }).catch((e) => {
      sendJson(res, 400, { ok: false, error: e.message || "Could not save analysis.", code: "storage" });
    });
    return;
  }
  const analysisMatch = req.url.match(/^\/api\/analyses\/([^/]+)$/);
  if (req.method === "GET" && analysisMatch) {
    try {
      const user = getAuthenticatedUser(req, res);
      if (!user) return;
      const analysis = storage.loadAnalysis(user.id, decodeURIComponent(analysisMatch[1]));
      return analysis
        ? sendJson(res, 200, { ok: true, data: analysis })
        : sendJson(res, 404, { ok: false, error: "Saved analysis not found.", code: "not_found" });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Could not load saved analysis.", code: "storage" });
    }
  }
  if (req.method === "DELETE" && analysisMatch) {
    try {
      const user = getAuthenticatedUser(req, res);
      if (!user) return;
      const deleted = storage.deleteAnalysis(user.id, decodeURIComponent(analysisMatch[1]));
      return sendJson(res, deleted ? 200 : 404, { ok: deleted, data: { deleted } });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Could not delete saved analysis.", code: "storage" });
    }
  }
  if (req.method === "GET" && req.url === "/api/kb") return listKB(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`FinAssistant is running at http://localhost:${PORT}`);
  console.log(`Model: ${MODEL} (override with GOOGLE_MODEL=... )`);
  if (!API_KEY) console.log("⚠  No GOOGLE_API_KEY found. Add it to .env (copy .env.example) or set it as an environment variable, then restart.");
});
