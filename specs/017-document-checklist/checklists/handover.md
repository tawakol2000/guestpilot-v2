# Handover & Data Integrity Checklist: Document Checklist

**Purpose**: Validate requirements quality for the AI handover logic, tool design, and data integrity (US1-US3)
**Created**: 2026-03-23
**Feature**: [spec.md](../spec.md)
**Focus**: AI tool contracts, cross-agent data flow, image-to-document matching, state integrity
**Depth**: Standard
**Audience**: Author (pre-implementation gate)

## Requirement Completeness

- [X] CHK001 - Are document types exhaustively enumerated, or is the "passports + marriage certificates only" scope explicitly stated as a boundary? [Completeness, Spec §Assumptions]
- [X] CHK002 - Is the screening agent's decision logic for when to call the tool specified? (e.g., only on acceptance recommendations, or also on rejections?) [Completeness, Spec §US1]
- [X] CHK003 - Are requirements defined for what happens when the screening agent calls `create_document_checklist` more than once for the same reservation? (overwrite vs. reject vs. merge) [Gap, Spec §FR-001]
- [X] CHK004 - Is the coordinator's proactive document-asking frequency specified beyond "not on every message"? (e.g., first message only, every Nth message, or only when conversation is idle?) [Clarity, Spec §FR-007]
- [X] CHK005 - Are requirements defined for the `mark_document_received` tool's return value? (what data does the AI see after calling it?) [Gap, Plan §Tool 2]
- [X] CHK006 - Is the coordinator's behavior specified when it receives an image AND a pending checklist exists vs. when no checklist exists? [Completeness, Spec §US3]
- [X] CHK007 - Are requirements defined for how the checklist interacts with the existing image handling flow? (does `mark_document_received` replace escalation, or supplement it?) [Gap]

## Requirement Clarity

- [X] CHK008 - Is "before or at the same time as escalating" (Spec §US1 line 18) clarified — does the tool call happen in the same API response as the escalation JSON, or as a separate turn? [Ambiguity, Spec §US1]
- [X] CHK009 - Is "naturally remind" (Spec §US2) quantified with specific behavioral rules that an AI prompt can enforce? [Clarity, Spec §FR-007]
- [X] CHK010 - Is "clearly a passport, ID, or marriage certificate" (Plan §Tool 2 description) defined with criteria the AI can apply consistently? [Clarity, Plan §Tool 2]
- [X] CHK011 - Is the distinction between "passport" and "ID" specified? (are they interchangeable in the checklist, or tracked separately?) [Ambiguity, Spec §US1]

## Requirement Consistency

- [X] CHK012 - Are the `create_document_checklist` parameters consistent between the spec (§FR-002: "passports needed + marriage cert needed") and the plan (§Tool 1: adds "reason" field)? [Consistency]
- [X] CHK013 - Is the checklist context injection format (Plan §Context Injection) consistent with how the coordinator prompt instruction (Spec §FR-007) references it? [Consistency]
- [X] CHK014 - Are the tool availability rules consistent — spec says coordinator has `mark_document_received`, but does it also need it when the checklist is complete or absent? [Consistency, Spec §FR-005 vs §FR-011]

## Scenario Coverage

- [X] CHK015 - Are requirements defined for the scenario where booking is accepted but no checklist was created? (manager override of rejection, instant book, direct channel) [Coverage, Spec §Edge Cases]
- [X] CHK016 - Are requirements defined for when the screening agent's tool call fails? (network error, DB write error) Does the escalation still proceed? [Coverage, Exception Flow]
- [X] CHK017 - Are requirements defined for when the coordinator's `mark_document_received` tool call fails? (does the AI still respond to the guest?) [Coverage, Exception Flow]
- [X] CHK018 - Is the scenario covered where the guest sends a document image with NO accompanying text? (image-only message + pending checklist) [Coverage, Spec §US3]
- [X] CHK019 - Are requirements defined for the transition from CONFIRMED to CHECKED_IN — does the checklist carry over and remain visible? [Coverage, Gap]

## Edge Case Coverage

- [X] CHK020 - Is the behavior specified when `passportsReceived` equals `passportsNeeded` but the guest sends another passport? (FR-006 says cap, but does the AI acknowledge the extra or ignore it?) [Edge Case, Spec §FR-006]
- [X] CHK021 - Is the behavior specified when the guest sends a document that is NOT a passport or marriage cert? (e.g., driver's license, national ID card — should these count as "passport"?) [Edge Case, Gap]
- [X] CHK022 - Is the race condition addressed where the manager manually marks a document received at the same time the AI marks it via tool? [Edge Case, Gap]
- [X] CHK023 - Is the behavior specified for reservations where guest count is 0 or null? (passportsNeeded would be 0) [Edge Case, Gap]
- [X] CHK024 - Are requirements defined for the checklist when a reservation is cancelled after checklist creation? (cleanup or ignore?) [Edge Case, Gap]

## Data Integrity

- [X] CHK025 - Is the JSON structure of `screeningAnswers.documentChecklist` defined with required vs optional fields? [Completeness, Plan §Data Model]
- [X] CHK026 - Are validation rules specified for the checklist data? (e.g., passportsNeeded >= 1, passportsReceived <= passportsNeeded) [Completeness, Spec §FR-006]
- [X] CHK027 - Is the `updatedAt` timestamp requirement specified — should it update on every tool call and manual override? [Gap, Plan §Data Model]
- [X] CHK028 - Is concurrent write protection specified for the JSON field? (two tool calls or manual+tool writing at the same time) [Gap]

## Dependencies & Assumptions

- [X] CHK029 - Is the assumption that `screeningAnswers` JSON field can store checklist data validated against the current Prisma schema? [Assumption, Spec §Assumptions]
- [X] CHK030 - Is the assumption that GPT-5.4 Mini can reliably identify passport images validated with any evidence or confidence level? [Assumption, Spec §Assumptions]
- [X] CHK031 - Is the dependency on the existing multi-tool support in `createMessage` validated? (plan notes it only processes ONE tool call per response — is this sufficient?) [Dependency, Plan §Multi-Tool]
- [X] CHK032 - Is the dependency on reservation status sync (INQUIRY→CONFIRMED) acknowledged? (the context injection only shows for CONFIRMED+ guests, but the 79 stale reservations bug means status may be wrong) [Dependency, Gap]
