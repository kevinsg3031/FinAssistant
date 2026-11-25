function createApprovalTasks({ requirements, validation, compliance, conflicts = [] }) {
  const flagged = new Set((validation.issues || []).filter((issue) => ["critical", "high"].includes(issue.severity)).map((issue) => issue.item));
  const mappings = compliance.mappings || [];
  const mappedIds = new Set(mappings.map((mapping) => mapping.requirementId));
  const unverified = new Set(mappings.filter((mapping) => mapping.status !== "supported" || mapping.confidence < 0.6).map((mapping) => mapping.requirementId));
  const conflicted = new Set(conflicts.flatMap((item) => item.requirementIds || []));
  return requirements.map((requirement) => ({
    requirementId: requirement.id,
    required: flagged.has(requirement.id) || unverified.has(requirement.id) || !mappedIds.has(requirement.id) || conflicted.has(requirement.id) || requirement.confidence < 0.6,
    status: "pending",
    reason: flagged.has(requirement.id) ? "Validation requires human review." : conflicted.has(requirement.id) ? "Requirement is involved in a detected conflict or dependency." : unverified.has(requirement.id) || !mappedIds.has(requirement.id) ? "Compliance evidence is incomplete or low confidence." : requirement.confidence < 0.6 ? "Requirement extraction/classification confidence is low." : "Owner review checkpoint.",
  }));
}

module.exports = { createApprovalTasks };
