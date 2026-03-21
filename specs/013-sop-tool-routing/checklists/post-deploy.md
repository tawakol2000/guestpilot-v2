# Post-Deploy Acceptance: SOP Tool Routing

**Purpose**: Validate the deployed system meets spec requirements. For user (Abdelrahman) + Claude to check together after deploy.
**Created**: 2026-03-21
**Actor**: User + Claude
**Timing**: After deploy to advanced-ai-v7

## Core Classification Quality

- [ ] CHK029 - Does the spec define how to validate that each of the 22 categories classifies correctly on representative messages? [Measurability, Spec §SC-006]
- [ ] CHK030 - Are the "representative test messages" for SC-006 documented or is this left to ad-hoc testing? [Completeness, Gap]
- [ ] CHK031 - Is the 95% high/medium confidence target (SC-001) measurable from the monitoring dashboard? [Measurability, Spec §SC-001]
- [ ] CHK032 - Is the benchmark of 100+ real guest messages (SC-002) defined — which messages, from which conversations? [Clarity, Spec §SC-002]
- [ ] CHK033 - Are multi-intent test scenarios specified beyond the single towels+wifi example? [Coverage, Spec §SC-007]

## Cost & Performance Acceptance

- [ ] CHK034 - Is the method for measuring per-message cost defined (which logs, which calculation)? [Measurability, Spec §SC-003]
- [ ] CHK035 - Is the baseline for "current system cost ~$0.004" documented with source data? [Clarity, Spec §SC-003]
- [ ] CHK036 - Is the method for measuring response latency increase defined (end-to-end, which timestamps)? [Measurability, Spec §SC-004]
- [ ] CHK037 - Are prompt caching hit rates measurable from existing logging? [Coverage, Gap]

## Legacy Removal Completeness

- [ ] CHK038 - Is there a defined method to verify no orphaned code references remain (grep, build check)? [Measurability, Spec §SC-009]
- [ ] CHK039 - Are the specific classifier API endpoints that should return 404 after removal listed for verification? [Completeness, Contracts §Endpoints REMOVED]
- [ ] CHK040 - Is the expected behavior of the frontend when visiting the old classifier tab URL defined? [Clarity, Gap]
- [ ] CHK041 - Are the read-only DB tables verifiable — is there a way to confirm no new writes occur? [Measurability, Spec §Assumptions]

## Monitoring Dashboard Acceptance

- [ ] CHK042 - Are the specific data points the monitoring dashboard must show defined with precision? [Completeness, Spec §FR-017]
- [ ] CHK043 - Is "classification distribution" defined — pie chart, bar chart, table, time series? [Clarity, Spec §US3]
- [ ] CHK044 - Is the "recent classifications" log defined with specific fields, sort order, and pagination? [Clarity, Spec §US3 scenario 3]
- [ ] CHK045 - Is the confidence filter (low/medium/high) requirement specified for the monitoring view? [Completeness, Contracts §GET /api/knowledge/sop-classifications]

## Graceful Degradation

- [ ] CHK046 - Are the failure scenarios that must be tested after deploy enumerated? [Completeness, Spec §FR-018]
- [ ] CHK047 - Is the expected guest-facing behavior during SOP retrieval failure specified precisely enough to verify? [Clarity, Spec §Edge Cases]
- [ ] CHK048 - Is the expected behavior when the AI API itself fails defined (separate from SOP retrieval failure)? [Coverage, Gap]

## Tool Coexistence

- [ ] CHK049 - Are acceptance test scenarios defined for property search tool working alongside get_sop? [Coverage, Quickstart §Scenario 7]
- [ ] CHK050 - Are acceptance test scenarios defined for extend-stay tool working alongside get_sop? [Coverage, Quickstart §Scenario 8]
- [ ] CHK051 - Is the expected call count per message type documented (2 calls for simple, 3 for tool+SOP)? [Clarity, Research §Decision 6]

## Escalation Path

- [ ] CHK052 - Is the escalation task creation requirement testable — what fields, what priority? [Measurability, Spec §FR-010]
- [ ] CHK053 - Are the specific message types that should trigger "escalate" classification documented for testing? [Completeness, Spec §Edge Cases]
- [ ] CHK054 - Is the interaction between tool-based escalation and existing escalation-enrichment service defined? [Consistency, Gap]

## Notes

- This checklist is for live verification after deployment
- User sends real guest messages (or uses sandbox) and validates behavior matches spec
- Items marked [Gap] may require spec updates before they can be verified
- Cost/performance items (CHK034-037) require collecting data over several hours of real traffic
