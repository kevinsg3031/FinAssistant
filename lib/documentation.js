function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function objects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
}

function normalizeUseCase(value) {
  return {
    ...value,
    id: text(value.id, "UC"),
    name: text(value.name, "Use case"),
    actors: strings(value.actors),
    preconditions: strings(value.preconditions),
    mainFlow: strings(value.mainFlow),
    alternateFlows: strings(value.alternateFlows),
    postconditions: strings(value.postconditions),
    requirementIds: strings(value.requirementIds),
  };
}

function normalizeUserStory(value) {
  return {
    ...value,
    id: text(value.id, "US"),
    asA: text(value.asA, "user"),
    iWant: text(value.iWant, "to use the system"),
    soThat: text(value.soThat, "I can achieve the project goal"),
    acceptanceCriteria: strings(value.acceptanceCriteria),
    requirementIds: strings(value.requirementIds),
  };
}

function normalizeDocumentation(output, { project, requirements, security, compliance, risks, sdlc }) {
  const source = output && typeof output === "object" && !Array.isArray(output) ? output : {};
  const rawSrs = source.srs && typeof source.srs === "object" && !Array.isArray(source.srs) ? source.srs : {};
  const requirementIds = new Set(requirements.map((item) => item.id));
  const fallbackScope = text(project?.description, "Project scope to be confirmed.");
  const expectedFunctional = requirements.filter((item) => item.type === "functional").map((item) => item.id);
  const expectedNonFunctional = requirements.filter((item) => item.type === "non-functional").map((item) => item.id);
  const srs = {
    ...rawSrs,
    title: text(rawSrs.title, `${text(project?.title, "Project")} - Software Requirements Specification`),
    purpose: text(rawSrs.purpose, `Document the requirements and controls for ${text(project?.title, "the proposed system")}.`),
    scope: text(rawSrs.scope, fallbackScope),
    assumptions: strings(rawSrs.assumptions),
    functionalRequirements: strings(rawSrs.functionalRequirements).filter((id) => requirementIds.has(id)),
    nonFunctionalRequirements: strings(rawSrs.nonFunctionalRequirements).filter((id) => requirementIds.has(id)),
    useCases: objects(rawSrs.useCases).map(normalizeUseCase),
    userStories: objects(rawSrs.userStories).map(normalizeUserStory),
    interfaces: strings(rawSrs.interfaces),
    securityPrivacy: strings(rawSrs.securityPrivacy),
    compliance: strings(rawSrs.compliance),
    operations: strings(rawSrs.operations),
    risks: strings(rawSrs.risks),
    sdlc: rawSrs.sdlc && typeof rawSrs.sdlc === "object" && !Array.isArray(rawSrs.sdlc) ? rawSrs.sdlc : {},
  };
  const generationNotes = strings(rawSrs.generationNotes);

  if (!srs.functionalRequirements.length && expectedFunctional.length) {
    srs.functionalRequirements = expectedFunctional;
    generationNotes.push("Functional requirement references were restored from the validated requirement set.");
  }
  if (!srs.nonFunctionalRequirements.length && expectedNonFunctional.length) {
    srs.nonFunctionalRequirements = expectedNonFunctional;
    generationNotes.push("Non-functional requirement references were restored from the validated requirement set.");
  }
  if (!rawSrs.scope || typeof rawSrs.scope !== "string") {
    generationNotes.push("Scope was populated from the original project brief.");
  }
  if (!srs.securityPrivacy.length) {
    srs.securityPrivacy = objects(security?.findings).map((item) => text(item.statement)).filter(Boolean);
  }
  if (!srs.compliance.length) {
    srs.compliance = objects(compliance?.mappings).map((item) => text(item.obligation || item.gap)).filter(Boolean);
  }
  if (!srs.risks.length) {
    srs.risks = objects(risks).map((item) => text(item.id)).filter(Boolean);
  }
  if (!Object.keys(srs.sdlc).length) {
    srs.sdlc = {
      model: text(sdlc?.recommendedModel, "TBD"),
      rationale: text(sdlc?.recommendationRationale, "TBD"),
      workflow: objects(sdlc?.workflow),
    };
  }

  const sourceTraceability = objects(source.traceability);
  const traceById = new Map();
  for (const item of sourceTraceability) {
    if (requirementIds.has(item.requirementId) && !traceById.has(item.requirementId)) {
      traceById.set(item.requirementId, item);
    }
  }
  const traceability = requirements.map((requirement) => {
    const existing = traceById.get(requirement.id) || {};
    return {
      requirementId: requirement.id,
      source: text(existing.source, text(requirement.source, "Project brief")),
      evidenceIds: strings(existing.evidenceIds),
      srsSection: text(existing.srsSection, requirement.type === "functional" ? "Functional requirements" : "Non-functional requirements"),
    };
  });
  if (traceability.length !== sourceTraceability.length || traceability.some((item, index) => item.requirementId !== sourceTraceability[index]?.requirementId)) {
    generationNotes.push("Traceability was aligned to every validated requirement and invalid or missing references were corrected.");
  }
  if (generationNotes.length) srs.generationNotes = [...new Set(generationNotes)];

  return { ...source, srs, traceability };
}

module.exports = { normalizeDocumentation };
