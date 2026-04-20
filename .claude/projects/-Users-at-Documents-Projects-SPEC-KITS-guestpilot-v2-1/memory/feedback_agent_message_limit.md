---
name: feedback_agent_message_limit
description: Battle test agents must send exactly 20 messages, never more. User was frustrated by agents sending 30-40+ messages.
type: feedback
---

Battle test agents must send EXACTLY 20 messages per conversation, not "minimum 20" or "at least 20." The user explicitly said 20, not more. Agents kept going to 30-40+ messages which wastes tokens and time.

**Why:** The user pays per token and the extra messages add no value — 20 messages is enough to test any flow. Agents going beyond 20 means they weren't listening to instructions.

**How to apply:** When spawning battle test agents, always say "EXACTLY 20 messages. Stop at 20. Do not send message 21." Make this a hard constraint, not a suggestion.
