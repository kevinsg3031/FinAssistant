// SQLite persistence for accounts, user workspaces and saved analysis snapshots.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_PATH = process.env.FINREQ_DB_PATH || path.join(__dirname, "..", "data", "finreq.sqlite");
const MAX_BYTES = 50 * 1024 * 1024;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch (error) { /* Keep running if the platform does not support chmod. */ }
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    username TEXT,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS user_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS saved_analyses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    use_case_id TEXT NOT NULL,
    use_case_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
if (!userColumns.includes("username")) db.exec("ALTER TABLE users ADD COLUMN username TEXT");

const existingUsernames = new Set(
  db.prepare("SELECT username FROM users WHERE username IS NOT NULL").all().map(({ username }) => username.toLowerCase()),
);
const usersWithoutUsername = db.prepare("SELECT id, email FROM users WHERE username IS NULL ORDER BY created_at, id").all();
const setUsername = db.prepare("UPDATE users SET username = ? WHERE id = ?");
for (const user of usersWithoutUsername) {
  const base = (user.email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 30) || "user").padEnd(3, "_");
  let username = base;
  for (let suffix = 2; existingUsernames.has(username.toLowerCase()); suffix++) {
    const tail = `-${suffix}`;
    username = `${base.slice(0, 30 - tail.length)}${tail}`;
  }
  setUsername.run(username, user.id);
  existingUsernames.add(username.toLowerCase());
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username COLLATE NOCASE)");

const analysisColumns = db.prepare("PRAGMA table_info(saved_analyses)").all().map((column) => column.name);
if (!analysisColumns.includes("user_id")) {
  db.exec("ALTER TABLE saved_analyses ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE");
}
db.exec("CREATE INDEX IF NOT EXISTS saved_analyses_user_created_at ON saved_analyses(user_id, created_at DESC)");

const getUserByEmail = db.prepare("SELECT id, email, username, password_salt, password_hash FROM users WHERE email = ?");
const getUserByUsername = db.prepare("SELECT id, email, username, password_salt, password_hash FROM users WHERE username = ? COLLATE NOCASE");
const getUserById = db.prepare("SELECT id, email, username FROM users WHERE id = ?");

function parsePayload(payload) {
  return JSON.parse(payload);
}

function validateSize(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
    throw new Error("Saved data exceeds the 50 MB per-record limit.");
  }
  return serialized;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}

function createUser(email, username, password) {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Enter a valid email address.");
  }
  const normalizedUsername = typeof username === "string" ? username.trim() : "";
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(normalizedUsername)) {
    throw new Error("Username must be 3–30 characters and use only letters, numbers, dots, underscores or hyphens.");
  }
  if (typeof password !== "string" || password.length < 10 || password.length > 1024) {
    throw new Error("Password must be between 10 and 1024 characters.");
  }
  if (getUserByEmail.get(normalizedEmail)) throw new Error("An account with that email already exists.");
  if (getUserByUsername.get(normalizedUsername)) throw new Error("That username is already taken.");

  const user = { id: crypto.randomUUID(), email: normalizedEmail, username: normalizedUsername };
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt).toString("hex");
  db.prepare("INSERT INTO users (id, email, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").
    run(user.id, user.email, user.username, salt, passwordHash, new Date().toISOString());
  return user;
}

function authenticateUser(identity, password) {
  const normalizedIdentity = typeof identity === "string" ? identity.trim() : "";
  const user = normalizedIdentity.includes("@")
    ? getUserByEmail.get(normalizedIdentity.toLowerCase())
    : getUserByUsername.get(normalizedIdentity);
  if (!user || typeof password !== "string") return null;
  const candidate = hashPassword(password, user.password_salt);
  const expected = Buffer.from(user.password_hash, "hex");
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) return null;
  return { id: user.id, email: user.email, username: user.username };
}

function createSession(userId) {
  if (!getUserById.get(userId)) throw new Error("Account not found.");
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_LIFETIME_MS;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").
    run(crypto.createHash("sha256").update(token).digest("hex"), userId, expiresAt);
  return { token, expiresAt };
}

function getSessionUser(token) {
  if (typeof token !== "string" || !token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = db.prepare(`SELECT users.id, users.email, users.username, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).get(tokenHash);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return { id: row.id, email: row.email, username: row.username };
}

function deleteSession(token) {
  if (typeof token !== "string" || !token) return;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

function loadState(userId) {
  const row = db.prepare("SELECT payload FROM user_state WHERE user_id = ?").get(userId);
  if (!row) return {};
  const safeState = sanitizeWorkspaceState(parsePayload(row.payload));
  const serialized = JSON.stringify(safeState);
  if (serialized !== row.payload) {
    db.prepare("UPDATE user_state SET payload = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?")
      .run(serialized, userId);
  }
  return safeState;
}

function sanitizeWorkspaceState(state) {
  const safeState = {
    version: 2,
    phase: state?.phase === "interviews" ? "interviews" : "choose",
    selected: typeof state?.selected === "string" ? state.selected : null,
    previewUseCase: typeof state?.previewUseCase === "string" ? state.previewUseCase : null,
    formRole: typeof state?.formRole === "string" ? state.formRole : null,
  };
  if (typeof state?.archiveId === "string" && state.archiveId.length <= 100) {
    safeState.archiveId = state.archiveId;
    return safeState;
  }
  if (Array.isArray(state?.interviews)) safeState.interviews = state.interviews;
  if (Array.isArray(state?.sources)) safeState.sources = state.sources;
  if (state?.activeInterview && typeof state.activeInterview === "object" && !Array.isArray(state.activeInterview)) {
    safeState.activeInterview = state.activeInterview;
  }
  if (state?.pipeline && typeof state.pipeline === "object" && !Array.isArray(state.pipeline)) {
    safeState.pipeline = state.pipeline;
  }
  if (state?.approvals && typeof state.approvals === "object" && !Array.isArray(state.approvals)) {
    safeState.approvals = state.approvals;
  }
  if (typeof state?.tab === "string") safeState.tab = state.tab;
  return safeState;
}

function saveState(userId, state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Saved application state must be a JSON object.");
  }
  db.prepare(`INSERT INTO user_state (user_id, payload, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).
    run(userId, validateSize(sanitizeWorkspaceState(state)));
}

function saveAnalysis(userId, { id, title, useCase, state }) {
  if (!id || typeof id !== "string" || id.length > 100) throw new Error("Invalid saved-analysis id.");
  if (!title || typeof title !== "string" || !title.trim() || title.length > 160) throw new Error("Analysis title must be 1–160 characters.");
  if (!useCase || typeof useCase.id !== "string" || typeof useCase.name !== "string") throw new Error("A use case is required to save an analysis.");
  if (!state || typeof state !== "object" || !state.pipeline || !state.pipeline.complete) throw new Error("Only completed analyses can be saved.");

  const createdAt = new Date().toISOString();
  const payload = validateSize({ version: 1, useCase, ...state });
  db.prepare(`INSERT INTO saved_analyses (id, user_id, title, use_case_id, use_case_name, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, userId, title.trim(), useCase.id, useCase.name, createdAt, payload);
  return db.prepare("SELECT id, title, use_case_id, use_case_name, created_at FROM saved_analyses WHERE id = ? AND user_id = ?").get(id, userId);
}

function listAnalyses(userId) {
  return db.prepare(`SELECT id, title, use_case_id AS useCaseId, use_case_name AS useCaseName, created_at AS createdAt
    FROM saved_analyses WHERE user_id = ? ORDER BY created_at DESC`).all(userId);
}

function loadAnalysis(userId, id) {
  const row = db.prepare(`SELECT id, title, use_case_id, use_case_name, created_at, payload FROM saved_analyses
    WHERE id = ? AND user_id = ?`).get(id, userId);
  if (!row) return null;
  return { ...row, payload: parsePayload(row.payload) };
}

function deleteAnalysis(userId, id) {
  return db.prepare("DELETE FROM saved_analyses WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

module.exports = {
  createUser,
  authenticateUser,
  createSession,
  getSessionUser,
  deleteSession,
  loadState,
  saveState,
  saveAnalysis,
  listAnalyses,
  loadAnalysis,
  deleteAnalysis,
};
