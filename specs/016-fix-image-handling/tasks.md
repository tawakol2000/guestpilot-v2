# Tasks: Fix Image Handling

**Input**: Design documents from `/specs/016-fix-image-handling/`
**Prerequisites**: plan.md, spec.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Delete Old Image Code

**Purpose**: Remove the broken, duplicated image branch and the dynamic injection function

- [X] T001 [US1] Delete the entire image branch (the `else` block after `if (!hasImages)`) in `generateAndSendAiReply` in `backend/src/services/ai.service.ts` — lines ~1996–2114 including separate imageTemplateVars, imageContent building, separate createMessage call, and duplicate response parsing
- [X] T002 [US1] Delete the `injectImageHandling()` function (~lines 561–586) and remove it from the exports at the bottom of `backend/src/services/ai.service.ts`
- [X] T003 [US1] Remove the `ContentBlock` image variant (`| { type: 'image'; source: ... }`) from the type union at line 72 in `backend/src/services/ai.service.ts` — only keep the text variant
- [X] T004 [US1] Remove the `if (!hasImages) {` wrapper around the text branch so it becomes the only code path — unwrap the block, keep its contents, delete the closing `} else {` and everything after it

**Checkpoint**: Code compiles with zero image handling — text-only works, images are simply ignored

---

## Phase 2: Bake Image Instructions into System Prompts

**Purpose**: Add image handling permanently into both prompts for prompt caching efficiency

- [X] T005 [US1] Add the IMAGE HANDLING section (from the deleted `injectImageHandling` function content) into `OMAR_SYSTEM_PROMPT` in `backend/src/services/ai.service.ts`, placed before the OUTPUT FORMAT section
- [X] T006 [P] [US1] Add the IMAGE HANDLING section into `OMAR_SCREENING_SYSTEM_PROMPT` in `backend/src/services/ai.service.ts`, placed before the OUTPUT FORMAT section

**Checkpoint**: Both system prompts permanently include image handling instructions — no dynamic injection needed

---

## Phase 3: Single-Path Image Support

**Purpose**: Download image and attach to the existing inputTurns — one code path for text and text+image

- [X] T007 [US1] Add image download logic before the `createMessage` call in `generateAndSendAiReply` in `backend/src/services/ai.service.ts`: when `hasImages` is true, find the first message with imageUrls, download via axios, convert to base64, detect MIME type (jpeg/png/gif/webp). On download failure: log warning, set imageBase64 to empty string
- [X] T008 [US1] When imageBase64 is non-empty, modify the last entry in the `inputTurns` array to use multi-part content in OpenAI Responses API format: change `{role: 'user', content: string}` to `{role: 'user', content: [{type: 'input_text', text: lastUserMessage}, {type: 'input_image', image_url: {url: 'data:{mimeType};base64,{imageBase64}'}}]}` in `backend/src/services/ai.service.ts`
- [X] T009 [US2] When hasImages is true but imageBase64 is empty (download failed), prepend a system note to the last user message text: "[System: The guest sent an image but it could not be loaded. Acknowledge this and escalate to manager.]" in `backend/src/services/ai.service.ts`
- [X] T010 [US1] Set `hasImage: hasImages` (instead of hardcoded `false`) in the createMessage options in `backend/src/services/ai.service.ts`

**Checkpoint**: Images are downloaded, attached to the last user turn in OpenAI format, and sent through the same code path as text — tools, streaming, SOP classification, reasoning effort all work with images

---

## Phase 4: Cleanup & Verify

**Purpose**: Remove dead code references and verify compilation

- [X] T011 Remove any remaining references to `injectImageHandling` across the codebase (check imports, exports, sandbox.ts) in `backend/src/services/ai.service.ts` and any other files that import it
- [X] T012 Verify TypeScript compilation succeeds with `cd backend && npx tsc --noEmit`

**Checkpoint**: Clean compile, single code path, image handling baked into prompts, old branch fully deleted

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (Delete): Start immediately — remove old broken code
- **Phase 2** (Bake prompts): Can run in parallel with Phase 1 (different code sections)
- **Phase 3** (Single-path): Depends on Phase 1 completion (needs the unwrapped single path)
- **Phase 4** (Cleanup): Depends on all previous phases

### Execution Order

T001 → T004 (sequential — same code block, must delete then unwrap)
T002, T003 (parallel with T001 — different code sections)
T005, T006 (parallel — different prompts)
T007 → T008 → T010 (sequential — each builds on previous)
T009 (parallel with T008 — different condition branch)
T011 → T012 (sequential — cleanup then verify)
