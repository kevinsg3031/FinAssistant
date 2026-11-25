const http = require("http");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

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
const agents = require("./lib/agents/index");
const coordinator = require("./lib/coordinator");
const { GoogleAIError } = require("./lib/google");
const storage = require("./lib/storage");
const { maskSensitiveText } = require("./lib/masking");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GOOGLE_MODEL || "gemini-3.8-flash";
const API_KEY = process.env.GOOGLE_API_KEY || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const SESSION_COOKIE = "finreq_session";

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
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      raw += c;
      if (Buffer.byteLength(raw, "utf8") > 2 * 1024 * 1024) {
        tooLarge = true;
        reject(new Error("Request body exceeds the 2 MB limit."));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
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
  sendJson(res, 500, { ok: false, code: "model_unavailable", error: "The model service is not configured on this server." });
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
const projectTurn = route(async ({ project, conversation, userMessage }) => {
  if (!project || typeof project.description !== "string" || !project.description.trim()) {
    throw new Error("Add a project description before continuing.");
  }
  if (typeof userMessage !== "string" || !userMessage.trim()) throw new Error("A chat message is required.");
  const safeProject = {
    ...project,
    title: typeof project.title === "string" ? maskSensitiveText(project.title).masked : "",
    description: maskSensitiveText(project.description).masked,
  };
  const safeConversation = (Array.isArray(conversation) ? conversation : []).map((item) => ({
    ...item,
    text: typeof item?.text === "string" ? maskSensitiveText(item.text).masked : "",
  }));
  return agents.stakeholderInteraction.run({
    apiKey: API_KEY,
    model: MODEL,
    project: safeProject,
    conversation: safeConversation,
    userMessage: maskSensitiveText(userMessage).masked,
  });
});

async function analyzeProject(req, res) {
  const user = getAuthenticatedUser(req, res);
  if (!user || !requireKey(res)) return;
  let body;
  try {
    body = await readBody(req);
    if (!body.project || typeof body.project.description !== "string" || !body.project.description.trim()) {
      throw new Error("Add a project description before analysis.");
    }
    if (!Array.isArray(body.conversation) || body.conversation.length === 0) {
      throw new Error("Describe the proposed system in the project chat before analysis.");
    }
    const project = {
      title: typeof body.project.title === "string" ? maskSensitiveText(body.project.title.trim().slice(0, 200)).masked : "",
      description: maskSensitiveText(body.project.description.slice(0, 100000)).masked,
      jurisdictions: Array.isArray(body.project.jurisdictions)
        ? body.project.jurisdictions.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 20)
        : [],
    };
    const conversation = body.conversation
      .filter((item) => item && ["user", "assistant"].includes(item.speaker) && typeof item.text === "string")
      .map((item) => ({ speaker: item.speaker, text: maskSensitiveText(item.text.slice(0, 20000)).masked }));
    const sources = Array.isArray(body.sources)
      ? body.sources.filter((item) => item && typeof item.text === "string").map((item, index) => ({
          id: typeof item.id === "string" ? item.id : `SOURCE-${index + 1}`,
          title: typeof item.title === "string" ? maskSensitiveText(item.title.slice(0, 160)).masked : `Pasted source ${index + 1}`,
          text: maskSensitiveText(item.text.slice(0, 30000)).masked,
        }))
      : [];
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    const emit = (event) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      const result = await coordinator.runAnalysis({
        apiKey: API_KEY,
        model: MODEL,
        project,
        conversation,
        sources,
        onStage: async (stage) => emit({ type: "stage", stage }),
      });
      emit({ type: "result", data: result });
    } catch (error) {
      if (error instanceof GoogleAIError) {
        emit({ type: "error", error: error.message, code: error.code });
      } else {
        emit({ type: "error", error: error.message || "Analysis failed.", code: "analysis" });
      }
    }
  } catch (error) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message || "Analysis request failed." })}\n\n`);
    } else {
      sendJson(res, 400, { ok: false, error: error.message || "Analysis request failed.", code: "analysis" });
    }
  } finally {
    if (res.getHeader("Content-Type")?.toString().startsWith("text/event-stream") && !res.destroyed) res.end();
  }
}

// --- Knowledge base (read-only browse; no API key needed, it's local metadata) ----
const listKB = route(async () => kb.listAll(), { skipKeyCheck: true });

function serveStatic(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const reqPath = pathname === "/" ? "/index.html" : pathname;
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
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

function printable(value) {
  return String(value == null ? "TBD" : value)
    .normalize("NFKD")
    .replace(/[^\x20-\x7E\n]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function pdfSection(document, title, value) {
  document.moveDown(0.5).font("Helvetica-Bold").fontSize(12).text(printable(title));
  document.moveDown(0.15).font("Helvetica").fontSize(9);
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) {
    document.text("TBD");
  } else {
    values.forEach((item) => {
      const text = typeof item === "string" ? item : JSON.stringify(item);
      document.text(Array.isArray(value) ? `- ${printable(text)}` : printable(text), { indent: Array.isArray(value) ? 8 : 0 });
    });
  }
}

function createSrsPdf(res, payload) {
  const project = payload.project || {};
  const result = payload.pipeline || {};
  const srs = result.srs || {};
  const document = new PDFDocument({ size: "A4", margins: { top: 52, bottom: 52, left: 52, right: 52 }, bufferPages: true });
  document.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Could not generate the SRS PDF.", code: "pdf" });
    else if (!res.destroyed) res.destroy(error);
  });
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${encodeURIComponent((project.title || "FinAssistant-SRS").replace(/[^a-z0-9-_]+/gi, "-"))}.pdf"`,
    "Cache-Control": "private, no-store",
  });
  document.pipe(res);
  document.font("Helvetica-Bold").fontSize(20).text(printable(srs.title || `${project.title || "Project"} — Software Requirements Specification`));
  document.moveDown(0.4).font("Helvetica").fontSize(9)
    .text(`Project: ${printable(project.title || "Untitled")}`)
    .text(`Generated: ${new Date().toISOString()}`)
    .text(`Operating jurisdictions: ${printable((project.jurisdictions || []).join(", ") || "Not specified")}`);
  pdfSection(document, "1. Purpose", srs.purpose);
  pdfSection(document, "2. Scope", srs.scope || project.description);
  pdfSection(document, "3. Assumptions", srs.assumptions || []);
  const requirements = result.requirements || [];
  pdfSection(document, "4. Functional requirements", requirements.filter((item) => item.type === "functional").map((item) => `${item.id} [${item.priority || "Unprioritized"}] ${item.statement} (source: ${item.source || "unspecified"}; confidence: ${Math.round((item.confidence || 0) * 100)}%)`));
  pdfSection(document, "5. Non-functional requirements", requirements.filter((item) => item.type === "non-functional").map((item) => `${item.id} [${(item.dimensions || []).join(", ")}] ${item.statement} (source: ${item.source || "unspecified"}; confidence: ${Math.round((item.confidence || 0) * 100)}%)`));
  pdfSection(document, "6. User stories and acceptance criteria", (srs.userStories || []).map((item) =>
    `${item.id}: As ${item.asA}, I want ${item.iWant}, so that ${item.soThat}. Acceptance: ${(item.acceptanceCriteria || []).join(" | ")}. Requirements: ${(item.requirementIds || []).join(", ")}`));
  pdfSection(document, "7. Use cases", (srs.useCases || []).map((item) =>
    `${item.id} ${item.name}. Actors: ${(item.actors || []).join(", ")}. Preconditions: ${(item.preconditions || []).join("; ")}. Main flow: ${(item.mainFlow || []).join("; ")}. Alternatives: ${(item.alternateFlows || []).join("; ")}. Postconditions: ${(item.postconditions || []).join("; ")}. Requirements: ${(item.requirementIds || []).join(", ")}`));
  pdfSection(document, "8. Interfaces", srs.interfaces || []);
  pdfSection(document, "9. Security and privacy", srs.securityPrivacy || []);
  pdfSection(document, "10. Compliance mapping", (result.compliance || []).map((item) =>
    `${item.requirementId}: ${item.obligation || item.gap || "Unverified"} [${item.status || "unverified"}; jurisdiction: ${item.jurisdiction || "unspecified"}; evidence: ${(item.citedEvidenceIds || []).join(", ") || "none"}]`));
  pdfSection(document, "11. Operations", srs.operations || []);
  pdfSection(document, "12. Risks", (result.risks || []).map((item) => `${item.id} [${item.severity || "unrated"}] ${item.description}. Mitigation: ${item.mitigation || "TBD"}.`));
  pdfSection(document, "13. Recommended SDLC", `${result.sdlc?.recommendedModel || "TBD"}: ${result.sdlc?.recommendationRationale || "No rationale supplied."}`);
  pdfSection(document, "14. SDLC alternatives", (result.sdlc?.candidates || []).map((item) =>
    `${item.model} (${item.score ?? "?"}/100): ${item.justification || ""}. Pros: ${(item.pros || []).join("; ")}. Cons: ${(item.cons || []).join("; ")}. Evidence: ${(item.citedEvidenceIds || []).join(", ") || "none"}`));
  pdfSection(document, "15. Tailored workflow", (result.sdlc?.workflow || []).map((item) =>
    `${item.phase}: Activities ${(item.activities || []).join("; ")}. Roles ${(item.roles || []).join(", ")}. Deliverables ${(item.deliverables || []).join("; ")}. Gate ${item.validationGate || "TBD"}. Security ${(item.securityControls || []).join("; ")}. Compliance ${(item.complianceCheckpoints || []).join("; ")}.`));
  pdfSection(document, "16. Traceability", (result.traceability || []).map((item) =>
    `${item.requirementId} -> ${item.srsSection || "SRS section TBD"}; source: ${item.source || "unspecified"}; evidence: ${(item.evidenceIds || []).join(", ") || "none"}`));
  document.end();
}

const ROUTES = { "/api/project/turn": projectTurn };

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
  if (req.method === "POST" && req.url === "/api/pipeline/analyze") return analyzeProject(req, res);
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
  const pdfMatch = req.url.match(/^\/api\/analyses\/([^/]+)\/srs\.pdf$/);
  if (req.method === "GET" && pdfMatch) {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;
    try {
      const record = storage.loadAnalysis(user.id, decodeURIComponent(pdfMatch[1]));
      if (!record) return sendJson(res, 404, { ok: false, error: "Saved analysis not found.", code: "not_found" });
      if (!record.payload.pipeline?.complete) return sendJson(res, 409, { ok: false, error: "Only completed analyses have an SRS PDF.", code: "incomplete" });
      return createSrsPdf(res, record.payload);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: "Could not generate the SRS PDF.", code: "pdf" });
    }
  }
  const approvalMatch = req.url.match(/^\/api\/analyses\/([^/]+)\/approval$/);
  if (req.method === "POST" && approvalMatch) {
    readBody(req).then((body) => {
      const user = getAuthenticatedUser(req, res);
      if (!user) return;
      const payload = storage.recordApproval(
        user.id,
        decodeURIComponent(approvalMatch[1]),
        body.requirementId,
        body.status,
        body.note || "",
        { userId: user.id, username: user.username },
      );
      if (!payload) return sendJson(res, 404, { ok: false, error: "Saved analysis not found.", code: "not_found" });
      sendJson(res, 200, { ok: true, data: payload });
    }).catch((error) => sendJson(res, 400, { ok: false, error: error.message || "Could not record approval.", code: "approval" }));
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
});
