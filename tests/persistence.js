// SQLite persistence and saved-analysis integration checks.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finreq-storage-test-"));
process.env.FINREQ_DB_PATH = path.join(dir, "state.sqlite");
const unownedLegacyState = { version: 1, selected: "payment", interviews: { payment: [{ roleLabel: "Auditor" }] }, views: {} };
fs.writeFileSync(path.join(dir, "legacy-state.json"), JSON.stringify(unownedLegacyState));
const legacyDb = new Database(process.env.FINREQ_DB_PATH);
legacyDb.exec(`CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
)`);
const legacySalt = crypto.randomBytes(16).toString("hex");
legacyDb.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run(
  "legacy-account", "legacy.user@example.com", legacySalt,
  crypto.scryptSync("legacy-password", legacySalt, 64).toString("hex"), new Date().toISOString(),
);
legacyDb.close();
const storage = require("../lib/storage");
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failed++;
};

try {
  const alice = storage.createUser("Alice@example.com", "Alice", "correct horse battery");
  const bob = storage.createUser("bob@example.com", "Bob", "another safe password");
  check("account email is normalized", alice.email === "alice@example.com");
  check("username sign-in is case-insensitive", storage.authenticateUser("aLiCe", "correct horse battery")?.id === alice.id);
  check("email sign-in and wrong-password rejection remain supported", storage.authenticateUser("ALICE@example.com", "correct horse battery")?.id === alice.id && storage.authenticateUser(alice.email, "incorrect") === null);
  check("existing accounts receive a username during migration", storage.authenticateUser("legacy.user", "legacy-password")?.username === "legacy.user");
  check("new account does not inherit unowned legacy workspace data", JSON.stringify(storage.loadState(alice.id)) === "{}");
  const aliceState = { version: 2, phase: "interviews", selected: "payment", interviews: [{ roleLabel: "Auditor" }], sources: [{ type: "Meeting notes", masked: "masked" }], activeInterview: { roleLabel: "Auditor", transcript: [] } };
  const bobState = { version: 2, selected: "fraud" };
  storage.saveState(alice.id, aliceState);
  storage.saveState(bob.id, bobState);
  const savedAliceState = storage.loadState(alice.id);
  const savedBobState = storage.loadState(bob.id);
  check("current analysis interviews and sources survive workspace reload", savedAliceState.selected === "payment" && savedAliceState.interviews[0].roleLabel === "Auditor" && savedAliceState.sources[0].masked === "masked" && savedAliceState.activeInterview.roleLabel === "Auditor" && savedBobState.selected === "fraud");
  const migrationDb = new Database(process.env.FINREQ_DB_PATH);
  migrationDb.prepare("UPDATE user_state SET payload = ? WHERE user_id = ?").run(
    JSON.stringify({ version: 1, ...unownedLegacyState, selected: "payment", views: { payment: { pipeline: { complete: false } } } }),
    alice.id,
  );
  migrationDb.close();
  const migratedState = storage.loadState(alice.id);
  check("legacy per-use-case drafts are purged during workspace migration", !("interviews" in migratedState) && !("pipeline" in migratedState) && migratedState.version === 2);
  storage.saveState(alice.id, { version: 2, phase: "interviews", selected: "payment", archiveId: "analysis-one", interviews: [{ roleLabel: "Already archived" }] });
  const archivedReference = storage.loadState(alice.id);
  check("archived workspace references do not duplicate saved interview payloads", archivedReference.archiveId === "analysis-one" && !("interviews" in archivedReference));

  const session = storage.createSession(alice.id);
  check("session token resolves to its account", storage.getSessionUser(session.token)?.id === alice.id);
  storage.deleteSession(session.token);
  check("deleted session token no longer authenticates", storage.getSessionUser(session.token) === null);

  const snapshot = {
    interviews: [{ roleLabel: "Auditor", transcript: [{ speaker: "stakeholder", text: "Keep the audit trail." }] }],
    sources: [{ type: "Meeting notes", masked: "Masked source text" }],
    pipeline: { complete: true, requirements: [{ id: "FR-1" }], risks: [] },
    approvals: { "FR-1": "approve" },
  };
  const item = storage.saveAnalysis(alice.id, { id: "analysis-one", title: "Payment review", useCase: { id: "payment", name: "Payment Processing" }, state: snapshot });
  check("saved analysis metadata is returned", item.title === "Payment review" && item.use_case_id === "payment");
  const loaded = storage.loadAnalysis(alice.id, "analysis-one");
  check("saved analysis restores interviews, sources, pipeline and approvals", JSON.stringify(loaded.payload) === JSON.stringify({ version: 1, useCase: { id: "payment", name: "Payment Processing" }, ...snapshot }));
  check("analysis list includes only the account's records", storage.listAnalyses(alice.id).some((row) => row.id === "analysis-one") && storage.listAnalyses(bob.id).length === 0);
  check("other account cannot read or delete the analysis", storage.loadAnalysis(bob.id, "analysis-one") === null && !storage.deleteAnalysis(bob.id, "analysis-one"));

  let incompleteRejected = false;
  try { storage.saveAnalysis(alice.id, { id: "incomplete", title: "Incomplete", useCase: { id: "payment", name: "Payment Processing" }, state: { pipeline: { complete: false } } }); } catch (e) { incompleteRejected = true; }
  check("incomplete analyses are rejected", incompleteRejected);
  check("saved analysis can be deleted", storage.deleteAnalysis(alice.id, "analysis-one") && storage.loadAnalysis(alice.id, "analysis-one") === null);
  check("missing analysis cannot be deleted", !storage.deleteAnalysis(alice.id, "missing"));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);