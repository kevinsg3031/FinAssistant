// SQLite persistence and saved-analysis integration checks.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finreq-storage-test-"));
process.env.FINREQ_DB_PATH = path.join(dir, "state.sqlite");
const unownedLegacyState = { version: 1, selected: "payment", interviews: { payment: [{ roleLabel: "Auditor" }] }, views: {} };
fs.writeFileSync(path.join(dir, "legacy-state.json"), JSON.stringify(unownedLegacyState));
const storage = require("../lib/storage");
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failed++;
};

try {
  const alice = storage.createUser("Alice@example.com", "correct horse battery");
  const bob = storage.createUser("bob@example.com", "another safe password");
  check("account email is normalized", alice.email === "alice@example.com");
  check("correct password authenticates and wrong password is rejected", storage.authenticateUser("ALICE@example.com", "correct horse battery")?.id === alice.id && storage.authenticateUser(alice.email, "incorrect") === null);
  check("new account does not inherit unowned legacy workspace data", JSON.stringify(storage.loadState(alice.id)) === "{}");
  const aliceState = { ...unownedLegacyState, selected: "payment" };
  const bobState = { version: 1, selected: "fraud", interviews: {}, views: {} };
  storage.saveState(alice.id, aliceState);
  storage.saveState(bob.id, bobState);
  check("workspace state saves independently per account", JSON.stringify(storage.loadState(alice.id)) === JSON.stringify(aliceState) && JSON.stringify(storage.loadState(bob.id)) === JSON.stringify(bobState));

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