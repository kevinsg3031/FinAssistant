# SDLC selection

The SDLC-Selection Agent compares six approaches named in the project brief: Agile, DevSecOps, Spiral, V-Model, Waterfall, and hybrid. Its input includes the project description, classified requirements, risks, change characteristics, regulatory criticality, and retrieved `sdlc-rule` evidence.

The model returns a relative 0–100 suitability score for each candidate, a justification, pros/cons, citations to retrieved rules, and a recommended project-specific workflow. The values are comparative model judgments, not probabilities or a deterministic scoring formula. The Coordinator does not silently select a winner if the evidence is weak; owners should review the recommendation and the alternatives.

The workflow is expected to describe phases, activities, roles, deliverables, validation gates, security controls, and compliance checkpoints. The SRS incorporates the selected model, rationale, and workflow, and the PDF includes the alternatives and traceability context.

The seed knowledge base contains illustrative selection heuristics, not universal lifecycle rules. A production organization should replace them with approved delivery policy and calibrate selection criteria against its actual risk, regulatory, and change-management practices.
