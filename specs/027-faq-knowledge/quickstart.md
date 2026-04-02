# Quickstart: FAQ Knowledge System

## Prerequisites

- Backend running with database access
- At least one property with active conversations
- A tenant account with manager access

## Test 1: Manual FAQ Creation (P3)

1. Open the new FAQs page from the top navigation
2. Click "Add FAQ"
3. Fill in: Q: "Is there a gym nearby?" A: "Yes, O1 Mall has a full gym — 1 minute walk." Category: local-recommendations. Scope: Property (select Apartment 203).
4. **Verify**: Entry appears as ACTIVE in the FAQ list
5. **Verify**: Entry shows under the "Local Recommendations" category

## Test 2: AI Answers From FAQ (P1)

1. Create an active FAQ entry for a property (from Test 1)
2. Send a guest message: "Hey, is there a gym I can use nearby?"
3. **Verify**: The AI responds using the FAQ content ("O1 Mall gym, 1 minute walk...")
4. **Verify**: No `info_request` escalation is created
5. **Verify**: The FAQ entry's usage count increments by 1

## Test 3: AI Falls Back When No FAQ (P1)

1. Send a guest message about a topic with NO FAQ entry: "Are there any coworking spaces nearby?"
2. **Verify**: The AI calls `get_faq` with category "local-recommendations"
3. **Verify**: No matching FAQ found → AI escalates as `info_request` as usual
4. **Verify**: Normal escalation behavior is unchanged

## Test 4: Auto-Suggest From Manager Reply (P2)

1. Wait for an `info_request` escalation (or trigger one from Test 3)
2. Reply as the manager: "Yes, there's a coworking space called The Cribb, 10 minutes walk from Building 8."
3. **Verify**: An inline "Save as FAQ?" prompt appears below the manager's reply in the chat
4. **Verify**: The extracted Q&A shows: Q: "Are there coworking spaces nearby?" A: "The Cribb, 10 minutes walk from Building 8."
5. **Verify**: The suggestion also appears on the FAQs page under "Suggested"

## Test 5: Approve FAQ Suggestion (P2)

1. From the inline prompt (Test 4), click "Approve"
2. **Verify**: The entry becomes ACTIVE
3. **Verify**: The scope defaults to "This property" — toggle to "Global" if desired
4. Send another guest message at the same property: "Is there a coworking space?"
5. **Verify**: The AI now answers from the FAQ without escalating

## Test 6: Booking-Specific Reply Skipped (P2)

1. Trigger an `info_request` escalation
2. Reply as the manager with a booking-specific answer: "Your check-in is December 18th at 3pm. I've noted your early arrival request."
3. **Verify**: NO "Save as FAQ?" prompt appears (reply contains booking-specific details)

## Test 7: Global vs Property Scope (P1)

1. Create a global FAQ: Q: "Do you accept pets?" A: "No, pets are not allowed in any of our apartments."
2. Send a guest message at ANY property: "Can I bring my dog?"
3. **Verify**: The AI answers from the global FAQ
4. Create a property-specific FAQ for Apartment 301: Q: "Do you accept pets?" A: "Small pets under 5kg are allowed with a $50 cleaning fee."
5. Send a guest message at Apartment 301: "Can I bring my dog?"
6. **Verify**: The AI uses the property-specific answer (not the global one)

## Test 8: Markdown Tool Output (P2)

1. Trigger a `get_sop` call (e.g., guest asks about early check-in)
2. Check the AI logs
3. **Verify**: The SOP tool output is in Markdown format (headers, bullet points) not JSON
4. **Verify**: The AI response quality is at least as good as before

## Test 9: Staleness Detection

1. Create an FAQ entry and do NOT use it for 90+ days (or temporarily lower the threshold for testing)
2. Run the staleness check
3. **Verify**: The entry is marked as STALE
4. **Verify**: It appears in the FAQs page with a "stale" badge
5. **Verify**: The AI can still use it (stale ≠ archived)

## Key Files

| File | Purpose |
|------|---------|
| `backend/prisma/schema.prisma` | FaqEntry model |
| `backend/src/services/faq.service.ts` | FAQ CRUD, retrieval, usage tracking |
| `backend/src/services/faq-suggest.service.ts` | Auto-suggest pipeline |
| `backend/src/services/ai.service.ts` | get_faq tool handler + Markdown SOP output |
| `backend/src/controllers/faq.controller.ts` | FAQ management endpoints |
| `backend/src/routes/faq.ts` | FAQ routes |
| `frontend/components/faq-v5.tsx` | FAQs page |
| `frontend/components/inbox-v5.tsx` | Inline "Save as FAQ?" prompt |
| `frontend/lib/api.ts` | FAQ API functions |
