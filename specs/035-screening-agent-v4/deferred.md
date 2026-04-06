# Deferred Items: Screening Agent v4

**Created**: 2026-04-06
**Feature**: 035-screening-agent-v4

## Deferred from this feature

### 1. Gate A: Duplicate Screening Prevention (Programmatic)
**What**: Application code that prevents the model from re-screening when an existing screening escalation is in open_tasks.
**Why defer**: The v4 prompt has Path A with pre-computed `existing_screening_escalation_exists` flag. The model should follow this. Monitor for 2 weeks — if re-screening rate > 5%, implement the gate.
**Implementation notes**: Check open_tasks for eligible-*/violation-*/awaiting-manager-review titles. Downgrade to reply if found.

### 2. Gate B: Screening Info Completeness (Soft Check)
**What**: Keyword detection against conversation history to verify nationality/composition are present before accepting a screening decision.
**Why defer**: It's a soft gate (log-only). The reasoning field already shows what the model based its decision on. If hallucination is detected via reasoning review, implement.
**Implementation notes**: Nationality keyword list + composition keyword list against conversation text. Log warning only, no downgrade.

### 3. Gate C: Document Checklist Idempotency (Programmatic)
**What**: Prevent duplicate create_document_checklist calls by checking conversation metadata.
**Why defer**: Our createChecklist service already handles idempotency via upsert. A duplicate call is wasteful but not harmful. The pre-computed `document_checklist_already_created` flag should prevent duplicates at the prompt level.

### 4. Eval Harness (30+ Test Cases)
**What**: Automated test suite covering all 21 screening paths with labeled input/expected-output pairs.
**Why defer**: Important tooling but doesn't block the screening rewrite. The worked examples in the prompt serve as manual test cases.

### 5. Wave-Based Rollout
**What**: Deploy to 10% of inquiry traffic first, monitor, then expand.
**Why defer**: We don't have traffic splitting infrastructure. Deploy to all inquiry traffic and monitor via AI Logs.

### 6. Per-Path Feature Flags
**What**: Ability to roll back specific screening paths to v1 behavior.
**Why defer**: Complexity. If regression detected, roll back the entire screening prompt.

### 7. Separate compute_screening_context_variables Function
**What**: Expert recommended a separate function for screening pre-computed context.
**Why defer / reject**: The coordinator's computeContextVariables already computes most of what screening needs. Extend it with screening-specific fields (existing_screening_escalation_exists, document_checklist_already_created) conditionally rather than duplicating.
