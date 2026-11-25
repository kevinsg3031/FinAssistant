const { jurisdictionMatches } = require("./kb");

function applyComplianceRules(mappings, { jurisdictions = [], retrievedEvidence = [], requirementIds = [] }) {
  const allowedEvidence = new Map(retrievedEvidence.map((item) => [item.id, item]));
  const issues = [];
  const normalized = (mappings || []).map((mapping) => {
    let status = ["supported", "partial", "unverified"].includes(mapping.status) ? mapping.status : "unverified";
    let gap = typeof mapping.gap === "string" ? mapping.gap : "";
    const citedIds = Array.isArray(mapping.citedEvidenceIds) ? [...new Set(mapping.citedEvidenceIds.filter((id) => typeof id === "string"))] : [];
    const unsupportedIds = citedIds.filter((id) => !allowedEvidence.has(id));
    const citedEvidence = citedIds.map((id) => allowedEvidence.get(id)).filter(Boolean);

    if (!jurisdictions.length) {
      status = "unverified";
      gap ||= "Jurisdiction was not established; applicability cannot be verified.";
    } else if (unsupportedIds.length) {
      status = "unverified";
      gap ||= `Citation(s) were not retrieved for this mapping: ${unsupportedIds.join(", ")}.`;
      issues.push({ item: mapping.requirementId, severity: "high", description: "Compliance mapping cites evidence that was not retrieved for the Compliance Agent." });
    } else if (!citedEvidence.length) {
      status = "unverified";
      gap ||= "No retrieved evidence supports a compliance mapping.";
    } else if (citedEvidence.some((item) => !jurisdictionMatches(item.jurisdiction, jurisdictions))) {
      status = "unverified";
      gap ||= "Retrieved evidence does not match the project's stated jurisdiction.";
      issues.push({ item: mapping.requirementId, severity: "high", description: "Compliance evidence jurisdiction does not match the project scope." });
    } else if (citedEvidence.some((item) => /illustrative|demo|seed/i.test(item.source || ""))) {
      status = "unverified";
      gap ||= "The retrieved source is illustrative and cannot establish legal applicability.";
    }

    if (status !== mapping.status) {
      issues.push({ item: mapping.requirementId, severity: "medium", description: `Rule-based compliance check downgraded the model's "${mapping.status || "missing"}" status to "unverified".` });
    }
    return {
      ...mapping,
      status,
      gap: gap || null,
      citedEvidenceIds: citedIds.filter((id) => allowedEvidence.has(id)),
      confidence: Math.max(0, Math.min(1, Number(mapping.confidence) || 0)),
    };
  });
  const mappedIds = new Set(normalized.map((mapping) => mapping.requirementId));
  for (const requirementId of requirementIds) {
    if (mappedIds.has(requirementId)) continue;
    normalized.push({
      requirementId,
      obligation: null,
      jurisdiction: jurisdictions.join(", ") || null,
      status: "unverified",
      citedEvidenceIds: [],
      evidence: [],
      confidence: 0,
      gap: "The Compliance Agent did not return a mapping for this requirement.",
    });
    issues.push({ item: requirementId, severity: "high", description: "No compliance mapping was returned for this requirement." });
  }
  for (const mapping of normalized) {
    if (requirementIds.length && !requirementIds.includes(mapping.requirementId)) {
      issues.push({ item: mapping.requirementId, severity: "high", description: "Compliance mapping references an unknown requirement ID." });
    }
  }
  return { mappings: normalized, issues };
}

module.exports = { applyComplianceRules };
