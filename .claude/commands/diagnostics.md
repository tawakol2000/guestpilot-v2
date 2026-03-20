Run embedding diagnostics — pull all AI pipeline data since the last run and display a per-message breakdown.

## Instructions

1. Read `EMBEDDING_DIAGNOSTICS.md` from the repo root to get the "Last run" timestamp.

2. Connect to the production database:
   ```
   cd backend && node -e "require('dotenv').config(); ..."
   ```
   The `.env` file must have `DATABASE_URL` set (use `railway run printenv` to get it if missing).

3. Query `AiApiLog` for all entries since the last run timestamp (or last 24 hours if first run):
   - Order by createdAt ASC
   - Include: createdAt, agentName, conversationId, model, costUsd, durationMs, responseText, ragContext
   - Exclude system prompts and full SOP content

4. For each log entry, display the diagnostic format from EMBEDDING_DIAGNOSTICS.md:
   - Extract guest message from userContent (last "Guest:" line)
   - Show Tier 1 classification (confidence, tier, labels, top 3 candidates)
   - Show Tier 3 status (re-injected, topic switch, centroid similarity)
   - Show Tier 2 status (fired or not, topic, SOPs)
   - Show selected SOPs (category names only, no content)
   - Show AI response (first 200 chars)
   - Show escalation if any
   - Show judge evaluation if available
   - Flag anomalies with emoji markers

5. After all messages, show summary stats:
   - Total messages
   - Classifier method distribution (lr_sigmoid vs none vs knn_rerank)
   - Confidence tier distribution (high/medium/low/undefined)
   - Tier 2 fire rate
   - Duplicate SOP count
   - Topic switch count
   - Escalation count
   - Auto-fix count
   - Average cost and duration

6. Update `EMBEDDING_DIAGNOSTICS.md` "Last run" timestamp to now.

7. If anomalies are found, list them at the end with recommendations.
