'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronDown, ChevronUp, Shield, AlertTriangle, History, Code, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import {
  apiGetAIConfig,
  apiUpdateAIConfig,
  apiGetAiConfigVersions,
  apiRevertAiConfigVersion,
  apiGetTenantAiConfig,
  apiUpdateTenantAiConfig,
  apiResetSystemPrompts,
  apiGetTemplateVariables,
  apiGetPromptHistory,
  type AiConfig,
  type AiPersonaConfig,
  type AiConfigVersion,
  type TenantAiConfig,
  type TemplateVariableInfo,
} from '@/lib/api'
import AutomatedRepliesSection from '@/components/settings/automated-replies-section'
import DocHandoffSection from '@/components/settings/doc-handoff-section'

// ─── Design Tokens ────────────────────────────────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706' },
  border: { default: '#E7E5E4', strong: '#1C1917' },
  shadow: {
    sm: '0 1px 2px rgba(12,10,9,0.04)',
    md: '0 4px 6px -1px rgba(12,10,9,0.06), 0 2px 4px -2px rgba(12,10,9,0.04)',
    lg: '0 10px 25px -5px rgba(12,10,9,0.08), 0 4px 10px -5px rgba(12,10,9,0.03)',
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  radius: { sm: 8, md: 12, lg: 16 },
} as const

// ─── Model options ─────────────────────────────────────────────────────────────
const MODEL_OPTIONS = [
  'gpt-5.4-mini-2026-03-17',  // Default — best balance of cost + quality (~$0.001/msg)
  'gpt-5.4-mini',              // Latest mini (auto-updates)
  'gpt-5.4-nano',              // Budget tier (~$0.0004/msg)
  'gpt-5.4',                   // Premium tier (~$0.004/msg)
]

// ─── Persona definitions ──────────────────────────────────────────────────────
const PERSONAS: { key: keyof Pick<AiConfig, 'guestCoordinator' | 'screeningAI' | 'managerTranslator'>; name: string; accent: string }[] = [
  { key: 'guestCoordinator',  name: 'Guest Coordinator',  accent: '#1D4ED8' },
  { key: 'screeningAI',       name: 'Screening AI',       accent: '#15803D' },
  { key: 'managerTranslator', name: 'Manager Translator', accent: '#D97706' },
]

// ─── C4: Preset prompt templates ─────────────────────────────────────────────
const PROMPT_PRESETS = [
  { name: 'Omar v3 — Minimal + SOP RAG', prompt: `# OMAR — Lead Guest Coordinator, Boutique Residence

You are Omar, the Lead Guest Coordinator for Boutique Residence serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman.

BATCHED MESSAGES: If the guest sent multiple messages, read all, then respond with one natural reply.

---

## CONTEXT

1. **CONVERSATION HISTORY** — prior messages (older ones may appear as a bullet summary)
2. **PROPERTY & GUEST INFO** — guest details, access codes, amenities, and relevant procedures retrieved for this question. **Your source of truth.**
3. **OPEN TASKS** — existing escalations. Don't duplicate. Resolve when guest confirms a fix.
4. **CURRENT GUEST MESSAGE(S)** — respond to this.
5. **CURRENT LOCAL TIME** — for scheduling decisions.

If something isn't in your provided info or procedures, tell the guest you'll check and escalate.

---

## TONE

- Natural, professional. 1–2 sentences max.
- Always respond in English.
- Don't overuse the guest's name or exclamation marks.
- Never mention the manager, AI, or internal systems.
- "okay"/"thanks"/thumbs up with nothing to action → guest_message: "", escalation: null.

---

## OUTPUT FORMAT

Raw JSON only. No markdown, no code blocks.

{"guest_message":"Your message","escalation":null}
{"guest_message":"Your message","escalation":{"title":"kebab-case","note":"For Abdelrahman: guest name, unit, details","urgency":"immediate|scheduled|info_request"}}
{"guest_message":"","escalation":null}
{"guest_message":"","escalation":null,"resolveTaskId":"id-from-open-tasks"}

- "guest_message" and "escalation" always present
- escalation: null or {title, note, urgency}
- Include guest name and unit in escalation notes
- resolveTaskId/updateTaskId: optional, reference OPEN TASKS ids

---

## EXAMPLES

Guest: "What's the WiFi password?"
{"guest_message":"WiFi is [network from info], password is [password from info].","escalation":null}

Guest: "Thanks!"
{"guest_message":"","escalation":null}

---

## HARD BOUNDARIES

- Never authorize refunds, credits, or discounts
- Never guarantee arrival times
- Never guess info you don't have — escalate
- Never confirm early check-in or late checkout
- Never discuss internal processes or the manager
- Always uphold house rules — escalate pushback
- Prioritize safety above all
- When in doubt, escalate
- Never output anything other than the JSON object` },
  { name: 'Omar v3 — Screening Minimal + SOPs', prompt: `# OMAR — Guest Screening Assistant, Boutique Residence

You are Omar, a guest screening assistant for Boutique Residence serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman. You screen guest inquiries against house rules and escalate when a booking decision is needed.

Before responding, reason through what you already know from conversation history, what's still missing, then draft your response.

BATCHED MESSAGES: If the guest sent multiple messages, read all, then respond with one natural reply.

---

## CONTEXT

1. **CONVERSATION HISTORY** — prior messages (check first — never re-ask answered questions)
2. **PROPERTY & GUEST INFO** — guest name, booking dates, unit, relevant procedures retrieved for this message
3. **CURRENT GUEST MESSAGE(S)** — respond to this

---

## TONE

- Natural and professional. 1–2 sentences max.
- Always respond in English.
- Never mention the manager, AI, screening criteria, or government regulations. Say "house rules."
- Never reference JSON or internal processes.
- "okay"/"thanks"/👍 while awaiting booking decision → guest_message: "", escalate with title: "awaiting-manager-review"

When declining: polite but firm, one sentence. Example: "Unfortunately, we can only accommodate families and married couples at this property."

---

## SCREENING RULES

### Arab Nationals

**ACCEPTED:**
- Families (parents + children) — marriage cert + passports required after booking accepted, names must match
- Married couples — marriage certificate required after booking accepted
- Female-only groups (any size, including solo females)

**NOT ACCEPTED:**
- Single Arab men (except Lebanese/Emirati solo — see below)
- All-male Arab groups (any size)
- Unmarried Arab couples (fiancés, boyfriends/girlfriends, dating partners)
- Mixed-gender Arab groups that are not family

### Lebanese & Emirati Nationals (Exception — effective 1 March 2026)

**ACCEPTED:** Solo traveler only (male or female) — staying entirely alone in the unit
**NOT ACCEPTED:** Any group; unmarried couples; if traveling with anyone else, revert to standard Arab rules

### Non-Arab Nationals

**ACCEPTED:** All configurations — families, couples, friends, solo, any gender mix

### Mixed Nationality Groups

If ANY guest in the party is Arab, apply Arab rules to the ENTIRE party.
Example: British man + Egyptian woman (unmarried) = NOT accepted

### Critical Rules

- Always ask nationality explicitly — never assume from names
- You can assume gender from names unless ambiguous (e.g., "Nour" — ask)
- Documents sent AFTER booking acceptance, not before. If asked where to send docs: "Once the booking is accepted, you can send them through the chat."
- Guests who refuse to provide required documents = NOT accepted

---

## OUTPUT FORMAT

Raw JSON only. No markdown, no code blocks.

{"guest message":"Your message","manager":{"needed":false,"title":"","note":""}}
{"guest message":"Your message","manager":{"needed":true,"title":"category-label","note":"For Abdelrahman: guest name, unit, nationality, party details, recommendation."}}
{"guest message":"","manager":{"needed":true,"title":"awaiting-manager-review","note":"Guest [Name] — screening complete, awaiting booking decision. [Recommendation]."}}

---

## EXAMPLES

Guest: "Hi, I'd like to book"
{"guest message":"Hi, thanks for reaching out. Could you share your nationality and who you'll be traveling with?","manager":{"needed":false,"title":"","note":""}}

Guest: "I'm French, traveling with my girlfriend"
{"guest message":"Great, we'd be happy to host you. Our team will confirm your reservation shortly.","manager":{"needed":true,"title":"eligible-non-arab","note":"French couple. Non-Arab. Recommend acceptance."}}

---

## HARD BOUNDARIES

- Never assume nationality from names — always ask explicitly
- Never accept unmarried Arab couples — no exceptions, including fiancés
- Never confirm a booking yourself — always escalate to manager
- Never share screening criteria or mention government regulations
- Always request documents AFTER booking acceptance, not before
- When in doubt, escalate
- Never output anything other than the JSON object` },
  { name: 'Luxury Property', prompt: 'You are an elegant concierge for a luxury vacation rental. Use refined, professional language. Address guests by name. Offer personalized recommendations for fine dining, premium experiences, and exclusive local attractions. Maintain discretion and attentiveness at all times.' },
  { name: 'Budget-Friendly', prompt: 'You are a friendly, helpful host for a budget accommodation. Be warm, casual, and efficient. Focus on clear check-in instructions, practical local tips (affordable restaurants, public transport), and quick problem-solving. Keep responses concise.' },
  { name: 'Family-Friendly', prompt: 'You are a welcoming host for a family-friendly vacation rental. Be warm and helpful. Highlight child-friendly amenities, nearby family activities, parks, and restaurants. Proactively share safety information and tips for traveling with children.' },
  { name: 'Business Traveler', prompt: 'You are a professional host for business travelers. Be efficient and concise. Focus on WiFi details, workspace setup, nearby coffee shops, restaurants for business meals, and transportation to business districts. Respect their time.' },
  { name: 'Party/Group Stay', prompt: 'You are a fun, organized host for group stays. Share house rules clearly (noise, parking, max occupancy). Recommend group activities, restaurants with large tables, and nearby entertainment. Be friendly but firm about property rules.' },
]

// ─── Shimmer keyframes (injected once) ───────────────────────────────────────
const SHIMMER_STYLE_ID = 'configure-ai-shimmer'
function ensureShimmerStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(SHIMMER_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = SHIMMER_STYLE_ID
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&family=JetBrains+Mono:wght@400;500;600&display=swap');
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }
  `
  document.head.appendChild(style)
}

// ─── Skeleton loaders ─────────────────────────────────────────────────────────
function SkeletonCards(): React.ReactElement {
  useEffect(() => { ensureShimmerStyle() }, [])
  return (
    <>
      {[0, 1, 2].map(i => (
        <div
          key={i}
          style={{
            height: 80,
            background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
            backgroundSize: '200% 100%',
            borderRadius: T.radius.lg,
            marginBottom: 16,
            animation: 'shimmer 1.8s ease-in-out infinite',
            boxShadow: T.shadow.sm,
          }}
        />
      ))}
    </>
  )
}

// ─── Stop sequences input ─────────────────────────────────────────────────────
function StopSequencesInput({
  sequences,
  onRemove,
  onAdd,
}: {
  sequences: string[]
  onRemove: (index: number) => void
  onAdd: (value: string) => void
}): React.ReactElement {
  const [inputValue, setInputValue] = useState('')

  function commit(raw: string): void {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
    parts.forEach(p => onAdd(p))
    setInputValue('')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit(inputValue)
    }
  }

  function handleBlur(): void {
    if (inputValue.trim()) {
      commit(inputValue)
    }
  }

  return (
    <div>
      {sequences.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {sequences.map((seq, i) => (
            <span
              key={i}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: T.bg.secondary,
                border: `1px solid ${T.border.default}`,
                borderRadius: 999,
                padding: '3px 10px',
                fontSize: 12,
                fontFamily: T.font.mono,
                color: T.text.primary,
                boxShadow: T.shadow.sm,
                transition: 'box-shadow 0.15s ease',
              }}
            >
              {seq}
              <button
                onClick={() => onRemove(i)}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = T.status.red }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = T.text.tertiary }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  lineHeight: 1,
                  color: T.text.tertiary,
                  fontSize: 13,
                  display: 'inline-flex',
                  alignItems: 'center',
                  transition: 'color 0.12s ease',
                }}
                aria-label={`Remove stop sequence "${seq}"`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder="Type and press Enter or comma to add"
        style={{
          width: '100%',
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.sm,
          padding: '8px 12px',
          fontSize: 13,
          fontFamily: T.font.mono,
          background: T.bg.secondary,
          color: T.text.primary,
          outline: 'none',
          boxSizing: 'border-box',
          transition: 'box-shadow 0.2s ease, background 0.2s ease',
        }}
        onFocus={e => { e.currentTarget.style.boxShadow = `0 0 0 2px rgba(29,78,216,0.15)`; e.currentTarget.style.background = T.bg.primary }}
        onBlurCapture={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.background = T.bg.secondary }}
      />
    </div>
  )
}

// ─── Persona card ─────────────────────────────────────────────────────────────
function PersonaCard({
  personaKey,
  name,
  accent,
  config,
  onChange,
}: {
  personaKey: string
  name: string
  accent: string
  config: AiPersonaConfig
  onChange: (next: AiPersonaConfig) => void
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  function showToast(type: 'success' | 'error', message: string): void {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2000)
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      await apiUpdateAIConfig({ [personaKey]: config })
      showToast('success', 'Saved')
    } catch (err) {
      showToast('error', `Error: ${err instanceof Error ? err.message : 'Failed to save'}`)
    } finally {
      setSaving(false)
    }
  }

  function handleStopSeqAdd(value: string): void {
    const existing = config.stopSequences ?? []
    if (!existing.includes(value)) {
      onChange({ ...config, stopSequences: [...existing, value] })
    }
  }

  function handleStopSeqRemove(index: number): void {
    const next = (config.stopSequences ?? []).filter((_, i) => i !== index)
    onChange({ ...config, stopSequences: next.length ? next : undefined })
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    color: T.text.secondary,
    marginBottom: 6,
    fontFamily: T.font.sans,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    border: `1px solid ${T.border.default}`,
    borderRadius: T.radius.sm,
    padding: '8px 12px',
    fontSize: 13,
    background: T.bg.primary,
    color: T.text.primary,
    outline: 'none',
    fontFamily: T.font.sans,
    boxSizing: 'border-box',
    transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
  }

  const fieldStyle: React.CSSProperties = {
    marginBottom: 20,
  }

  function handleInputFocus(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void {
    e.currentTarget.style.boxShadow = `0 0 0 2px rgba(29,78,216,0.15)`
    e.currentTarget.style.borderColor = T.accent
  }

  function handleInputBlur(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void {
    e.currentTarget.style.boxShadow = 'none'
    e.currentTarget.style.borderColor = T.border.default
  }

  const cardIndex = PERSONAS.findIndex(p => p.key === personaKey)

  return (
    <div
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = T.shadow.lg }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = T.shadow.md }}
      style={{
        borderRadius: T.radius.lg,
        border: `1px solid ${T.border.default}`,
        marginBottom: 16,
        background: T.bg.primary,
        overflow: 'hidden',
        boxShadow: T.shadow.md,
        animation: 'fadeInUp 0.4s ease-out both',
        animationDelay: `${cardIndex * 0.08}s`,
        transition: 'box-shadow 0.25s ease',
      }}
    >
      {/* Top accent stripe */}
      <div style={{ height: 4, background: accent }} />
      {/* Header */}
      <div
        onClick={() => setExpanded(v => !v)}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = T.bg.secondary }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '14px 20px',
          cursor: 'pointer',
          userSelect: 'none',
          gap: 10,
          transition: 'background 0.15s ease',
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: 700,
            color: T.text.primary,
            fontFamily: T.font.sans,
            letterSpacing: '-0.01em',
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontSize: 11,
            color: T.text.secondary,
            fontFamily: T.font.mono,
            marginRight: 8,
            background: T.bg.secondary,
            border: `1px solid ${T.border.default}`,
            borderRadius: 999,
            padding: '2px 10px',
            boxShadow: T.shadow.sm,
          }}
        >
          {config.model}
        </span>
        {expanded
          ? <ChevronUp size={16} style={{ color: T.text.secondary, flexShrink: 0 }} />
          : <ChevronDown size={16} style={{ color: T.text.secondary, flexShrink: 0 }} />
        }
      </div>

      {/* Body */}
      {expanded && (
        <div
          style={{
            padding: 20,
            borderTop: `1px solid ${T.border.default}`,
            animation: 'fadeInUp 0.3s ease-out',
          }}
        >
          {/* Model */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Model</label>
            <select
              value={config.model}
              onChange={e => onChange({ ...config, model: e.target.value })}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              style={{
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                padding: '8px 12px',
                fontSize: 13,
                background: T.bg.primary,
                color: T.text.primary,
                outline: 'none',
                width: '100%',
                fontFamily: T.font.sans,
                cursor: 'pointer',
                transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2357534E' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                paddingRight: 32,
              }}
            >
              {MODEL_OPTIONS.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Temperature */}
          <div style={fieldStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Temperature</label>
              <span
                style={{
                  background: T.bg.tertiary,
                  borderRadius: T.radius.sm,
                  padding: '2px 10px',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: T.font.mono,
                  color: T.text.primary,
                  minWidth: 40,
                  textAlign: 'center',
                }}
              >
                {config.temperature.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={config.temperature}
              onChange={e => onChange({ ...config, temperature: parseFloat(e.target.value) })}
              style={{
                width: '100%',
                cursor: 'pointer',
                accentColor: accent,
                height: 6,
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                color: T.text.tertiary,
                marginTop: 4,
                fontFamily: T.font.mono,
              }}
            >
              <span>0.00 Precise</span>
              <span>1.00 Creative</span>
            </div>
          </div>

          {/* Max Tokens */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Max Tokens</label>
            <input
              type="number"
              value={config.maxTokens}
              onChange={e => {
                const v = parseInt(e.target.value, 10)
                if (!isNaN(v)) onChange({ ...config, maxTokens: v })
              }}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              style={{ ...inputStyle, fontFamily: T.font.mono, width: 160 }}
            />
          </div>

          {/* C4: Preset Prompt Templates */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Load Preset Template</label>
            <select
              value=""
              onChange={e => {
                const preset = PROMPT_PRESETS.find(p => p.name === e.target.value)
                if (preset) onChange({ ...config, systemPrompt: preset.prompt })
              }}
              style={{
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                padding: '8px 12px',
                fontSize: 13,
                background: T.bg.primary,
                color: T.text.tertiary,
                outline: 'none',
                width: '100%',
                fontFamily: T.font.sans,
                cursor: 'pointer',
                transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2357534E' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                paddingRight: 32,
              }}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
            >
              <option value="">Select a preset...</option>
              {PROMPT_PRESETS.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            <p style={{ fontSize: 11, color: T.text.tertiary, margin: '6px 0 0', fontFamily: T.font.sans, lineHeight: 1.4 }}>
              Choose a pre-built prompt template optimized for common property types.
            </p>
          </div>

          {/* System Prompt */}
          <div style={fieldStyle}>
            <label style={labelStyle}>System Prompt</label>
            <textarea
              value={config.systemPrompt}
              onChange={e => onChange({ ...config, systemPrompt: e.target.value })}
              spellCheck={false}
              onFocus={e => {
                e.currentTarget.style.boxShadow = `0 0 0 2px rgba(29,78,216,0.15)`
                e.currentTarget.style.borderColor = T.accent
                e.currentTarget.style.background = T.bg.primary
              }}
              onBlur={e => {
                e.currentTarget.style.boxShadow = 'none'
                e.currentTarget.style.borderColor = T.border.default
                e.currentTarget.style.background = T.bg.secondary
              }}
              style={{
                width: '100%',
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                padding: '10px 14px',
                fontSize: 12.5,
                background: T.bg.secondary,
                color: T.text.primary,
                outline: 'none',
                fontFamily: T.font.mono,
                minHeight: 120,
                resize: 'vertical',
                boxSizing: 'border-box',
                lineHeight: 1.65,
                transition: 'box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease',
              }}
            />
          </div>

          {/* Stop Sequences */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Stop Sequences</label>
            <StopSequencesInput
              sequences={config.stopSequences ?? []}
              onRemove={handleStopSeqRemove}
              onAdd={handleStopSeqAdd}
            />
          </div>

          {/* Save row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <button
              onClick={handleSave}
              disabled={saving}
              onMouseEnter={e => { if (!saving) { (e.currentTarget as HTMLButtonElement).style.background = '#2D2926'; (e.currentTarget as HTMLButtonElement).style.boxShadow = T.shadow.md } }}
              onMouseLeave={e => { if (!saving) { (e.currentTarget as HTMLButtonElement).style.background = T.border.strong; (e.currentTarget as HTMLButtonElement).style.boxShadow = T.shadow.sm } }}
              style={{
                background: T.border.strong,
                color: '#FFFFFF',
                border: 'none',
                borderRadius: T.radius.sm,
                padding: '9px 24px',
                fontSize: 13,
                fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.5 : 1,
                fontFamily: T.font.sans,
                transition: 'background 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease',
                boxShadow: T.shadow.sm,
                letterSpacing: '0.01em',
              }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>

            {toast && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: toast.type === 'success' ? T.status.green : T.status.red,
                  fontFamily: T.font.sans,
                }}
              >
                {toast.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function ConfigureAiV5(): React.ReactElement {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [tenantConfig, setTenantConfig] = useState<TenantAiConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [configVersion, setConfigVersion] = useState(0)

  const reloadConfig = useCallback((): void => {
    apiGetAIConfig()
      .then(data => {
        setConfig(data)
        setConfigVersion(v => v + 1)
      })
      .catch(() => { /* ignore reload errors */ })
  }, [])

  useEffect(() => {
    Promise.all([apiGetAIConfig(), apiGetTenantAiConfig()])
      .then(([aiData, tenantData]) => {
        setConfig(aiData)
        setTenantConfig(tenantData)
        setLoading(false)
      })
      .catch(err => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load config')
        setLoading(false)
      })
  }, [])

  function updatePersona(key: keyof Pick<AiConfig, 'guestCoordinator' | 'screeningAI' | 'managerTranslator'>, next: AiPersonaConfig): void {
    setConfig(prev => prev ? { ...prev, [key]: next } : prev)
  }

  useEffect(() => { ensureShimmerStyle() }, [])

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background: T.bg.secondary,
        padding: 32,
        fontFamily: T.font.sans,
      }}
    >
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        {/* Page heading */}
        <div style={{ marginBottom: 24, animation: 'fadeInUp 0.4s ease-out both' }}>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: T.text.primary,
              margin: 0,
              fontFamily: T.font.sans,
              letterSpacing: '-0.02em',
            }}
          >
            Configure AI
          </h1>
          <p
            style={{
              fontSize: 13,
              color: T.text.secondary,
              margin: '8px 0 0',
              fontFamily: T.font.sans,
              lineHeight: 1.5,
            }}
          >
            Configure your AI agent — name, model, behaviour, and advanced features like RAG knowledge search and memory summaries. Persona-level prompts are managed below.
          </p>
        </div>

        {/* Load error */}
        {loadError && (
          <div
            style={{
              background: 'rgba(220,38,38,0.05)',
              border: '1px solid rgba(220,38,38,0.15)',
              borderRadius: T.radius.md,
              padding: '12px 16px',
              fontSize: 13,
              color: T.status.red,
              marginBottom: 20,
              fontFamily: T.font.sans,
              boxShadow: T.shadow.sm,
            }}
          >
            Failed to load AI config: {loadError}
          </div>
        )}

        {/* Skeleton / content */}
        {loading ? (
          <SkeletonCards />
        ) : config ? (
          <>
            {/* Tenant AI Config — agent name, model, toggles */}
            {tenantConfig && (
              <TenantConfigSection
                config={tenantConfig}
                onChange={setTenantConfig}
              />
            )}

            {/* System Prompts — editable in DB */}
            {tenantConfig && (
              <SystemPromptsSection
                config={tenantConfig}
                onChange={setTenantConfig}
              />
            )}

            {/* Image Handling Instructions */}
            {tenantConfig && (
              <ImageHandlingSection
                config={tenantConfig}
                onChange={setTenantConfig}
              />
            )}

            {/* Escalation Settings */}
            <EscalationSettings
              escalation={config.escalation ?? { confidenceThreshold: 70, triggerKeywords: [], maxConsecutiveAiReplies: 5 }}
              onChange={next => setConfig(prev => prev ? { ...prev, escalation: next } : prev)}
            />

            {/* Feature 043 — Automated Replies for action-card escalations */}
            <div style={{
              marginTop: 24,
              padding: 16,
              background: '#fff',
              border: '1px solid #e5e5e5',
              borderRadius: 8,
            }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px', color: '#0C0A09' }}>
                Automated Replies
              </h3>
              <AutomatedRepliesSection />
            </div>

            {/* Feature 044: Doc-handoff WhatsApp */}
            <div style={{ marginTop: 24 }}>
              <DocHandoffSection />
            </div>

            {/* Version History */}
            <VersionHistory configVersion={configVersion} onRevert={reloadConfig} />
          </>
        ) : null}
      </div>
    </div>
  )
}

// ─── Tenant Config Section ────────────────────────────────────────────────────

function TenantConfigSection({
  config,
  onChange,
}: {
  config: TenantAiConfig
  onChange: (c: TenantAiConfig) => void
}): React.ReactElement {
  const [local, setLocal] = useState<TenantAiConfig>(config)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => { setLocal(config) }, [config])

  function showToast(type: 'success' | 'error', message: string): void {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2500)
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const updated = await apiUpdateTenantAiConfig({
        agentName: local.agentName,
        model: local.model,
        temperature: local.temperature,
        maxTokens: local.maxTokens,
        debounceDelayMs: local.debounceDelayMs,
        adaptiveDebounce: local.adaptiveDebounce,
        customInstructions: local.customInstructions,
        ragEnabled: local.ragEnabled,
        memorySummaryEnabled: local.memorySummaryEnabled,
        reasoningCoordinator: local.reasoningCoordinator,
        reasoningScreening: local.reasoningScreening,
        shadowModeEnabled: local.shadowModeEnabled,
        autopilotMinConfidence: local.autopilotMinConfidence,
      })
      onChange(updated)
      showToast('success', 'AI settings saved')
    } catch {
      showToast('error', 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const cardStyle: React.CSSProperties = {
    borderRadius: T.radius.lg,
    border: `1px solid ${T.border.default}`,
    background: T.bg.primary,
    marginBottom: 16,
    boxShadow: T.shadow.md,
    overflow: 'hidden',
    animation: 'fadeInUp 0.4s ease-out both',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: T.text.secondary,
    fontFamily: T.font.sans,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 6,
  }
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: T.radius.sm,
    border: `1px solid ${T.border.default}`,
    fontSize: 13,
    fontFamily: T.font.mono,
    color: T.text.primary,
    background: T.bg.secondary,
    outline: 'none',
    boxSizing: 'border-box',
  }
  const toggleRow = (label: string, sub: string, value: boolean, key: keyof TenantAiConfig): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${T.border.default}` }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans }}>{label}</div>
        <div style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans, marginTop: 2 }}>{sub}</div>
      </div>
      <button
        onClick={() => setLocal(prev => ({ ...prev, [key]: !prev[key as keyof TenantAiConfig] }))}
        style={{
          width: 44, height: 24, borderRadius: 12,
          background: value ? T.accent : T.bg.tertiary,
          border: 'none', cursor: 'pointer', position: 'relative',
          transition: 'background 0.2s', flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: value ? 23 : 3,
          width: 18, height: 18, borderRadius: 9,
          background: '#fff', transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }} />
      </button>
    </div>
  )

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border.default}`, background: T.bg.secondary, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: T.radius.sm, background: '#1D4ED818', border: '1px solid #1D4ED828', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z"/>
            <circle cx="12" cy="9" r="2.5"/>
          </svg>
        </div>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, letterSpacing: '-0.01em' }}>
            AI Agent Settings
          </span>
          <p style={{ fontSize: 12, color: T.text.secondary, margin: '2px 0 0', fontFamily: T.font.sans }}>
            Agent name, model, response behaviour, and advanced features
          </p>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: 20 }}>
        {/* Row: agent name + model */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div>
            <label style={labelStyle}>Agent Name</label>
            <input
              style={inputStyle}
              value={local.agentName}
              maxLength={50}
              onChange={e => setLocal(prev => ({ ...prev, agentName: e.target.value }))}
              placeholder="Omar"
            />
          </div>
          <div>
            <label style={labelStyle}>Model</label>
            <select
              style={{ ...inputStyle, cursor: 'pointer' }}
              value={local.model}
              onChange={e => setLocal(prev => ({ ...prev, model: e.target.value }))}
            >
              {MODEL_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        {/* Row: temperature + maxTokens + debounce */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div>
            <label style={labelStyle}>Temperature</label>
            <input
              style={inputStyle}
              type="number" min={0} max={1} step={0.05}
              value={local.temperature}
              onChange={e => setLocal(prev => ({ ...prev, temperature: parseFloat(e.target.value) || 0 }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Max Tokens</label>
            <input
              style={inputStyle}
              type="number" min={50} max={8000}
              value={local.maxTokens}
              onChange={e => setLocal(prev => ({ ...prev, maxTokens: parseInt(e.target.value) || 1024 }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Reply Delay (s)</label>
            <input
              style={inputStyle}
              type="number" min={5} max={600}
              value={Math.round(local.debounceDelayMs / 1000)}
              onChange={e => setLocal(prev => ({ ...prev, debounceDelayMs: (parseInt(e.target.value) || 30) * 1000 }))}
            />
          </div>
        </div>

        {/* Debounce settings */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <label style={labelStyle}>Adaptive Debounce</label>
            <button
              onClick={() => setLocal(prev => ({ ...prev, adaptiveDebounce: !prev.adaptiveDebounce }))}
              style={{
                width: 44, height: 24, borderRadius: 12,
                background: local.adaptiveDebounce ? T.accent : T.bg.tertiary,
                border: 'none', cursor: 'pointer', position: 'relative',
                transition: 'background 0.2s', flexShrink: 0,
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: local.adaptiveDebounce ? 23 : 3,
                width: 18, height: 18, borderRadius: 9,
                background: '#fff', transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </button>
          </div>
          <div style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans, lineHeight: 1.5 }}>
            {local.adaptiveDebounce ? (
              <>
                When a guest sends rapid-fire messages, the reply delay automatically extends:
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {[
                    { label: '3+ msgs / 60s', mult: '3x', value: Math.round(local.debounceDelayMs * 3 / 1000) },
                    { label: '6+ msgs / 60s', mult: '6x', value: Math.round(local.debounceDelayMs * 6 / 1000) },
                  ].map(tier => (
                    <div
                      key={tier.mult}
                      style={{
                        flex: 1,
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: T.bg.secondary,
                        border: `1px solid ${T.border.default}`,
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.text.primary, fontFamily: T.font.mono }}>{tier.mult}</div>
                      <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 2 }}>{tier.label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, fontFamily: T.font.mono, marginTop: 4 }}>{tier.value}s</div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>Fixed delay of {Math.round(local.debounceDelayMs / 1000)}s for every message, regardless of how fast the guest types.</>
            )}
          </div>
        </div>

        {/* Custom instructions */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Custom Instructions</label>
          <textarea
            style={{ ...inputStyle, height: 80, resize: 'vertical', lineHeight: 1.5 }}
            value={local.customInstructions}
            maxLength={2000}
            onChange={e => setLocal(prev => ({ ...prev, customInstructions: e.target.value }))}
            placeholder="Additional instructions for the AI agent (e.g. always reply in Spanish, sign off as the property manager, etc.)"
          />
          <div style={{ fontSize: 11, color: T.text.tertiary, textAlign: 'right', marginTop: 4, fontFamily: T.font.mono }}>
            {local.customInstructions.length} / 2000
          </div>
        </div>

        {/* Feature toggles */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Features</label>
          {toggleRow('RAG Knowledge Search', 'Retrieve relevant property knowledge before each reply', local.ragEnabled, 'ragEnabled')}
          <div style={{ borderBottom: 'none' }}>
            {toggleRow('Conversation Memory Summaries', 'Summarise older messages to reduce token usage', local.memorySummaryEnabled, 'memorySummaryEnabled')}
          </div>
        </div>

        {/* Feature 040: Copilot Shadow Mode — tuning section */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Tuning</label>
          <div style={{ borderBottom: 'none' }}>
            {toggleRow(
              'Shadow Mode (Copilot)',
              'Render copilot AI replies as in-chat preview bubbles (instead of the legacy suggestion card) and fire the tuning analyzer on edited sends. Does not affect autopilot. For tuning sessions only — turn off when done.',
              Boolean(local.shadowModeEnabled),
              'shadowModeEnabled'
            )}
          </div>
        </div>

        {/* Autopilot confidence threshold */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Autopilot Confidence Threshold</label>
          <div style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 10, lineHeight: 1.5 }}>
            On autopilot, if the AI self-rates its confidence below this threshold, the reply is held as a preview for human review instead of auto-sending. Higher = safer, more human review. Lower = more autonomy.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={local.autopilotMinConfidence ?? 0.75}
              onChange={e => setLocal(prev => ({ ...prev, autopilotMinConfidence: parseFloat(e.target.value) }))}
              style={{ flex: 1, accentColor: T.accent }}
            />
            <span style={{
              minWidth: 64,
              textAlign: 'right',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: T.font.mono,
              color: T.accent,
            }}>
              {(Math.round((local.autopilotMinConfidence ?? 0.75) * 100))}%
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
            <span>0% (always send)</span>
            <span>50%</span>
            <span>100% (never send)</span>
          </div>
        </div>

        {/* Reasoning level per agent */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Reasoning Level</label>
          <div style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 10 }}>
            Higher reasoning = smarter responses but slower and more expensive. &quot;Auto&quot; enables reasoning only for complex SOPs.
          </div>
          {(['Guest Coordinator', 'Screening Agent'] as const).map((agentLabel, idx) => {
            const key = idx === 0 ? 'reasoningCoordinator' : 'reasoningScreening'
            const value = local[key] || (idx === 0 ? 'auto' : 'none')
            const options = idx === 0 ? ['none', 'auto', 'low', 'medium', 'high'] : ['none', 'low', 'medium', 'high']
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: idx === 0 ? `1px solid ${T.border.default}` : 'none' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans }}>{agentLabel}</span>
                <div style={{ display: 'flex', gap: 0, borderRadius: T.radius.sm, overflow: 'hidden', border: `1px solid ${T.border.default}` }}>
                  {options.map(opt => (
                    <button
                      key={opt}
                      onClick={() => setLocal(prev => ({ ...prev, [key]: opt }))}
                      style={{
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: value === opt ? 700 : 500,
                        fontFamily: T.font.mono,
                        background: value === opt ? T.accent : T.bg.secondary,
                        color: value === opt ? '#fff' : T.text.secondary,
                        border: 'none',
                        cursor: 'pointer',
                        borderRight: `1px solid ${T.border.default}`,
                        textTransform: 'capitalize',
                        transition: 'background 0.15s, color 0.15s',
                      }}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '8px 20px', borderRadius: T.radius.sm,
              background: saving ? T.bg.tertiary : T.accent,
              color: saving ? T.text.secondary : '#fff',
              border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 600, fontFamily: T.font.sans,
              transition: 'background 0.2s',
            }}
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          {toast && (
            <span style={{ fontSize: 13, color: toast.type === 'success' ? T.status.green : T.status.red, fontFamily: T.font.sans }}>
              {toast.message}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}


// ─── Essential variable names (used for missing-variable warning) ────────────
const ESSENTIAL_VARIABLE_NAMES = ['CURRENT_MESSAGES', 'RESERVATION_DETAILS', 'CONVERSATION_HISTORY']

// ─── Variable Reference Panel ────────────────────────────────────────────────

function VariableReferencePanel({
  agentType,
  textareaRef,
  promptValue,
  onInsert,
}: {
  agentType: 'coordinator' | 'screening'
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  promptValue: string
  onInsert: (newValue: string) => void
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [variables, setVariables] = useState<TemplateVariableInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (expanded && !loaded) {
      apiGetTemplateVariables(agentType)
        .then(vars => { setVariables(vars); setLoaded(true) })
        .catch(() => setLoaded(true))
    }
  }, [expanded, loaded, agentType])

  function handleInsert(varName: string): void {
    const tag = `{${varName}}`
    const el = textareaRef.current
    if (el) {
      const start = el.selectionStart ?? promptValue.length
      const end = el.selectionEnd ?? start
      const newValue = promptValue.slice(0, start) + tag + promptValue.slice(end)
      onInsert(newValue)
      // Restore focus and cursor position after React re-render
      requestAnimationFrame(() => {
        el.focus()
        const newCursor = start + tag.length
        el.setSelectionRange(newCursor, newCursor)
      })
    } else {
      onInsert(promptValue + tag)
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0',
        }}
      >
        <Code size={12} color={T.text.tertiary} />
        <span style={{ fontSize: 11, fontWeight: 600, color: T.text.tertiary, fontFamily: T.font.sans }}>
          Template Variables
        </span>
        {expanded ? <ChevronUp size={11} color={T.text.tertiary} /> : <ChevronDown size={11} color={T.text.tertiary} />}
      </button>
      {expanded && (
        <div style={{
          marginTop: 6, padding: 10, borderRadius: T.radius.sm,
          background: T.bg.secondary, border: `1px solid ${T.border.default}`,
          maxHeight: 200, overflowY: 'auto',
        }}>
          {!loaded ? (
            <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>Loading...</span>
          ) : variables.length === 0 ? (
            <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>No variables available</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {variables.map(v => (
                <div key={v.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <button
                    onClick={() => handleInsert(v.name)}
                    title={`Insert {${v.name}} at cursor`}
                    style={{
                      padding: '2px 6px', borderRadius: 4,
                      background: v.essential ? '#1D4ED810' : T.bg.primary,
                      border: `1px solid ${v.essential ? '#1D4ED830' : T.border.default}`,
                      fontFamily: T.font.mono, fontSize: 10, fontWeight: 600,
                      color: v.essential ? T.accent : T.text.primary,
                      cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
                    }}
                  >
                    {'{' + v.name + '}'}
                  </button>
                  <span style={{ fontSize: 10, color: T.text.secondary, fontFamily: T.font.sans, lineHeight: 1.4, paddingTop: 2 }}>
                    {v.description}
                    {v.essential && (
                      <span style={{ color: T.accent, fontWeight: 600, marginLeft: 4 }}>required</span>
                    )}
                    {v.propertyBound && (
                      <span style={{ color: T.text.tertiary, marginLeft: 4 }}>per-listing</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Missing Variable Warning ────────────────────────────────────────────────

function MissingVariableWarning({ promptText }: { promptText: string }): React.ReactElement | null {
  const missing = ESSENTIAL_VARIABLE_NAMES.filter(name => !promptText.includes(`{${name}}`))
  if (missing.length === 0) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px',
      borderRadius: T.radius.sm, background: '#FEF3C710',
      border: `1px solid ${T.status.amber}30`,
    }}>
      <AlertTriangle size={14} color={T.status.amber} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 11, color: T.text.secondary, fontFamily: T.font.sans, lineHeight: 1.5 }}>
        {missing.map((name, i) => (
          <span key={name}>
            {i > 0 && ', '}
            Essential variable <span style={{ fontFamily: T.font.mono, fontWeight: 600, color: T.status.amber }}>
              {'{' + name + '}'}
            </span> is missing
          </span>
        ))}
        <span style={{ color: T.text.tertiary }}> — the system will auto-append {missing.length === 1 ? 'it' : 'them'}.</span>
      </div>
    </div>
  )
}

// ─── Content Block delimiter helpers ─────────────────────────────────────────

const CONTENT_BLOCKS_DELIMITER = '<!-- CONTENT_BLOCKS -->'
const BLOCK_DELIMITER = '<!-- BLOCK -->'

/** Split a full prompt string into { systemPrompt, blocks } */
function parseContentBlocks(fullPrompt: string): { systemPrompt: string; blocks: string[] } {
  const idx = fullPrompt.indexOf(CONTENT_BLOCKS_DELIMITER)
  if (idx === -1) return { systemPrompt: fullPrompt, blocks: [] }
  const systemPrompt = fullPrompt.slice(0, idx).trimEnd()
  const rest = fullPrompt.slice(idx + CONTENT_BLOCKS_DELIMITER.length)
  const blocks = rest.split(BLOCK_DELIMITER).map(b => b.replace(/^\n/, '').replace(/\n$/, ''))
  // Filter out completely empty leading block that results from leading newline
  if (blocks.length > 0 && blocks[0].trim() === '') blocks.shift()
  return { systemPrompt, blocks }
}

/** Join system prompt + blocks back into a single string */
function joinContentBlocks(systemPrompt: string, blocks: string[]): string {
  if (blocks.length === 0) return systemPrompt
  return systemPrompt.trimEnd() + '\n\n' + CONTENT_BLOCKS_DELIMITER + '\n' + blocks.join('\n' + BLOCK_DELIMITER + '\n')
}

// ─── Content Blocks Editor ──────────────────────────────────────────────────

const BLOCK_VARIABLES = [
  'CONVERSATION_HISTORY',
  'RESERVATION_DETAILS',
  'ACCESS_CONNECTIVITY',
  'PROPERTY_DESCRIPTION',
  'AVAILABLE_AMENITIES',
  'ON_REQUEST_AMENITIES',
  'CURRENT_MESSAGES',
  'OPEN_TASKS',
  'CURRENT_LOCAL_TIME',
  'DOCUMENT_CHECKLIST',
]

function ContentBlocksEditor({
  blocks,
  onChange,
  agentType,
}: {
  blocks: string[]
  onChange: (blocks: string[]) => void
  agentType: 'coordinator' | 'screening'
}): React.ReactElement {
  const blockRefs = useRef<(HTMLTextAreaElement | null)[]>([])

  function updateBlock(index: number, value: string): void {
    const next = [...blocks]
    next[index] = value
    onChange(next)
  }

  function addBlock(): void {
    onChange([...blocks, '### NEW BLOCK\n'])
  }

  function removeBlock(index: number): void {
    onChange(blocks.filter((_, i) => i !== index))
  }

  function moveBlock(index: number, direction: -1 | 1): void {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    const tmp = next[index]
    next[index] = next[target]
    next[target] = tmp
    onChange(next)
  }

  function insertVariable(index: number, varName: string): void {
    const tag = `{${varName}}`
    const el = blockRefs.current[index]
    if (el) {
      const start = el.selectionStart ?? blocks[index].length
      const end = el.selectionEnd ?? start
      const val = blocks[index]
      const newVal = val.slice(0, start) + tag + val.slice(end)
      updateBlock(index, newVal)
      requestAnimationFrame(() => {
        el.focus()
        const cursor = start + tag.length
        el.setSelectionRange(cursor, cursor)
      })
    } else {
      updateBlock(index, blocks[index] + tag)
    }
  }

  if (blocks.length === 0) {
    return (
      <div style={{ marginTop: 10 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8,
        }}>
          <span style={{
            fontSize: 11, fontWeight: 600, color: T.text.secondary,
            fontFamily: T.font.sans, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            Content Blocks
          </span>
        </div>
        <div style={{
          padding: '12px 14px', borderRadius: T.radius.sm,
          background: T.bg.secondary, border: `1px dashed ${T.border.default}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>
            No content blocks defined. The full prompt is sent as one system message.
          </span>
          <button
            onClick={addBlock}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: T.radius.sm,
              background: T.bg.primary, border: `1px solid ${T.border.default}`,
              fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
              color: T.accent, cursor: 'pointer',
            }}
          >
            <Plus size={11} /> Add Block
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: T.text.secondary,
          fontFamily: T.font.sans, letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>
          Content Blocks ({blocks.length})
        </span>
        <button
          onClick={addBlock}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '3px 8px', borderRadius: T.radius.sm,
            background: T.bg.primary, border: `1px solid ${T.border.default}`,
            fontSize: 10, fontWeight: 600, fontFamily: T.font.sans,
            color: T.accent, cursor: 'pointer',
          }}
        >
          <Plus size={10} /> Add Block
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {blocks.map((block, i) => (
          <div
            key={i}
            style={{
              borderRadius: T.radius.sm,
              border: `1px solid ${T.border.default}`,
              background: T.bg.primary,
              overflow: 'hidden',
            }}
          >
            {/* Block header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 10px',
              background: T.bg.secondary,
              borderBottom: `1px solid ${T.border.default}`,
            }}>
              <span style={{
                fontSize: 10, fontWeight: 700, color: T.text.secondary,
                fontFamily: T.font.mono, minWidth: 48,
              }}>
                Block {i + 1}
              </span>

              {/* Move up */}
              <button
                onClick={() => moveBlock(i, -1)}
                disabled={i === 0}
                title="Move up"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 20, borderRadius: 4,
                  background: 'none', border: 'none',
                  color: i === 0 ? T.text.tertiary : T.text.secondary,
                  cursor: i === 0 ? 'default' : 'pointer',
                  opacity: i === 0 ? 0.4 : 1,
                  padding: 0,
                }}
              >
                <ArrowUp size={11} />
              </button>

              {/* Move down */}
              <button
                onClick={() => moveBlock(i, 1)}
                disabled={i === blocks.length - 1}
                title="Move down"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 20, borderRadius: 4,
                  background: 'none', border: 'none',
                  color: i === blocks.length - 1 ? T.text.tertiary : T.text.secondary,
                  cursor: i === blocks.length - 1 ? 'default' : 'pointer',
                  opacity: i === blocks.length - 1 ? 0.4 : 1,
                  padding: 0,
                }}
              >
                <ArrowDown size={11} />
              </button>

              {/* Insert variable dropdown */}
              <select
                value=""
                onChange={e => {
                  if (e.target.value) insertVariable(i, e.target.value)
                  e.target.value = ''
                }}
                style={{
                  marginLeft: 'auto',
                  padding: '1px 4px', borderRadius: 4,
                  background: T.bg.primary, border: `1px solid ${T.border.default}`,
                  fontSize: 10, fontFamily: T.font.mono,
                  color: T.text.secondary, cursor: 'pointer',
                  appearance: 'none',
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='%2357534E' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 4px center',
                  paddingRight: 16,
                }}
              >
                <option value="">+ Variable</option>
                {BLOCK_VARIABLES.map(v => (
                  <option key={v} value={v}>{'{' + v + '}'}</option>
                ))}
              </select>

              {/* Delete */}
              <button
                onClick={() => removeBlock(i)}
                title="Delete block"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 20, borderRadius: 4,
                  background: 'none', border: 'none',
                  color: T.text.tertiary, cursor: 'pointer',
                  padding: 0,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = T.status.red }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = T.text.tertiary }}
              >
                <Trash2 size={11} />
              </button>
            </div>

            {/* Block textarea */}
            <textarea
              ref={el => { blockRefs.current[i] = el }}
              value={block}
              onChange={e => updateBlock(i, e.target.value)}
              spellCheck={false}
              rows={4}
              style={{
                width: '100%', resize: 'vertical',
                fontFamily: T.font.mono, fontSize: 10.5, lineHeight: 1.55,
                padding: '8px 10px', border: 'none',
                background: T.bg.primary, color: T.text.primary,
                boxSizing: 'border-box', outline: 'none',
              }}
              onFocus={e => {
                (e.currentTarget.parentElement as HTMLElement).style.borderColor = T.accent
              }}
              onBlur={e => {
                (e.currentTarget.parentElement as HTMLElement).style.borderColor = T.border.default
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── System Prompts Section ──────────────────────────────────────────────────

function SystemPromptsSection({
  config,
  onChange,
}: {
  config: TenantAiConfig
  onChange: (c: TenantAiConfig) => void
}): React.ReactElement {
  // Full prompt strings (what gets saved to the API)
  const [coordPrompt, setCoordPrompt] = useState(config.systemPromptCoordinator || '')
  const [screenPrompt, setScreenPrompt] = useState(config.systemPromptScreening || '')
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [expandedCoord, setExpandedCoord] = useState(false)
  const [expandedScreen, setExpandedScreen] = useState(false)
  const [saveWarnings, setSaveWarnings] = useState<string[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Array<{ version: number; timestamp: string; coordinator?: string; screening?: string }>>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const coordTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const screenTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setCoordPrompt(config.systemPromptCoordinator || '')
    setScreenPrompt(config.systemPromptScreening || '')
  }, [config])

  // Derived: split each full prompt into system-prompt part + content blocks
  const coordParsed = parseContentBlocks(coordPrompt)
  const screenParsed = parseContentBlocks(screenPrompt)

  // Update handlers that rebuild the full string when either part changes
  function setCoordSystemPart(text: string): void {
    setCoordPrompt(joinContentBlocks(text, coordParsed.blocks))
  }
  function setCoordBlocks(blocks: string[]): void {
    setCoordPrompt(joinContentBlocks(coordParsed.systemPrompt, blocks))
  }
  function setScreenSystemPart(text: string): void {
    setScreenPrompt(joinContentBlocks(text, screenParsed.blocks))
  }
  function setScreenBlocks(blocks: string[]): void {
    setScreenPrompt(joinContentBlocks(screenParsed.systemPrompt, blocks))
  }

  function showToast(type: 'success' | 'error', message: string): void {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2500)
  }

  function checkMissingEssentials(coordText: string, screenText: string): string[] {
    const warnings: string[] = []
    for (const name of ESSENTIAL_VARIABLE_NAMES) {
      const tag = `{${name}}`
      if (coordText && !coordText.includes(tag)) {
        warnings.push(`Coordinator prompt: {${name}} missing`)
      }
      if (screenText && !screenText.includes(tag)) {
        warnings.push(`Screening prompt: {${name}} missing`)
      }
    }
    return warnings
  }

  async function handleSave(): Promise<void> {
    // Show missing-variable warnings (non-blocking)
    const warnings = checkMissingEssentials(coordPrompt, screenPrompt)
    setSaveWarnings(warnings)

    setSaving(true)
    try {
      const updated = await apiUpdateTenantAiConfig({
        systemPromptCoordinator: coordPrompt,
        systemPromptScreening: screenPrompt,
      })
      onChange(updated)
      showToast('success', `System prompts saved (v${updated.systemPromptVersion})`)
    } catch (err: any) {
      showToast('error', err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleReset(): Promise<void> {
    if (!confirm('Reset both system prompts to the default seed values? Your edits will be lost.')) return
    setResetting(true)
    setSaveWarnings([])
    try {
      const updated = await apiResetSystemPrompts()
      onChange(updated)
      setCoordPrompt(updated.systemPromptCoordinator || '')
      setScreenPrompt(updated.systemPromptScreening || '')
      showToast('success', 'Prompts reset to defaults')
    } catch {
      showToast('error', 'Failed to reset')
    } finally {
      setResetting(false)
    }
  }

  const cardStyle: React.CSSProperties = {
    background: '#FFFFFF',
    borderRadius: T.radius.lg,
    border: `1px solid ${T.border.default}`,
    boxShadow: T.shadow.sm,
    overflow: 'hidden',
  }

  const coordDirty = coordPrompt !== (config.systemPromptCoordinator || '')
  const screenDirty = screenPrompt !== (config.systemPromptScreening || '')
  const hasChanges = coordDirty || screenDirty

  return (
    <div style={cardStyle}>
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border.default}`, background: T.bg.secondary, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: T.radius.sm, background: '#7C3AED18', border: '1px solid #7C3AED28', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Shield size={14} color="#7C3AED" strokeWidth={2.5} />
          </div>
          <div>
            <span style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>System Prompts</span>
            <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>
              Core AI personality and behavior — v{config.systemPromptVersion}
            </div>
          </div>
        </div>
        <button
          onClick={handleReset}
          disabled={resetting}
          style={{
            padding: '4px 10px', borderRadius: T.radius.sm,
            background: T.bg.primary, border: `1px solid ${T.border.default}`,
            fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
            color: T.text.secondary, cursor: 'pointer',
          }}
        >
          {resetting ? 'Resetting...' : 'Reset to Default'}
        </button>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Guest Coordinator Prompt */}
        <div>
          <button
            onClick={() => setExpandedCoord(!expandedCoord)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
            }}
          >
            {expandedCoord ? <ChevronUp size={14} color={T.text.secondary} /> : <ChevronDown size={14} color={T.text.secondary} />}
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans }}>
              Guest Coordinator
            </span>
            <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginLeft: 'auto' }}>
              {coordPrompt.length.toLocaleString()} chars
              {coordParsed.blocks.length > 0 && (
                <span style={{ marginLeft: 6 }}>{coordParsed.blocks.length} block{coordParsed.blocks.length !== 1 ? 's' : ''}</span>
              )}
              {coordDirty && <span style={{ color: T.status.amber, marginLeft: 6 }}>modified</span>}
            </span>
          </button>
          {expandedCoord && (
            <>
              <div style={{ marginTop: 8 }}>
                <div style={{
                  fontSize: 10, fontWeight: 600, color: T.text.tertiary,
                  fontFamily: T.font.sans, letterSpacing: '0.04em', textTransform: 'uppercase',
                  marginBottom: 4,
                }}>
                  System Instructions
                </div>
                <textarea
                  ref={coordTextareaRef}
                  value={coordParsed.systemPrompt}
                  onChange={e => setCoordSystemPart(e.target.value)}
                  style={{
                    width: '100%', height: 350, resize: 'vertical',
                    fontFamily: T.font.mono, fontSize: 11, lineHeight: 1.6,
                    padding: 12, borderRadius: T.radius.sm,
                    border: `1px solid ${coordDirty ? T.status.amber : T.border.default}`,
                    background: T.bg.primary, color: T.text.primary,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <VariableReferencePanel
                agentType="coordinator"
                textareaRef={coordTextareaRef}
                promptValue={coordParsed.systemPrompt}
                onInsert={setCoordSystemPart}
              />
              <ContentBlocksEditor
                blocks={coordParsed.blocks}
                onChange={setCoordBlocks}
                agentType="coordinator"
              />
            </>
          )}
        </div>

        {/* Screening Agent Prompt */}
        <div>
          <button
            onClick={() => setExpandedScreen(!expandedScreen)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
            }}
          >
            {expandedScreen ? <ChevronUp size={14} color={T.text.secondary} /> : <ChevronDown size={14} color={T.text.secondary} />}
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans }}>
              Screening Agent
            </span>
            <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginLeft: 'auto' }}>
              {screenPrompt.length.toLocaleString()} chars
              {screenParsed.blocks.length > 0 && (
                <span style={{ marginLeft: 6 }}>{screenParsed.blocks.length} block{screenParsed.blocks.length !== 1 ? 's' : ''}</span>
              )}
              {screenDirty && <span style={{ color: T.status.amber, marginLeft: 6 }}>modified</span>}
            </span>
          </button>
          {expandedScreen && (
            <>
              <div style={{ marginTop: 8 }}>
                <div style={{
                  fontSize: 10, fontWeight: 600, color: T.text.tertiary,
                  fontFamily: T.font.sans, letterSpacing: '0.04em', textTransform: 'uppercase',
                  marginBottom: 4,
                }}>
                  System Instructions
                </div>
                <textarea
                  ref={screenTextareaRef}
                  value={screenParsed.systemPrompt}
                  onChange={e => setScreenSystemPart(e.target.value)}
                  style={{
                    width: '100%', height: 350, resize: 'vertical',
                    fontFamily: T.font.mono, fontSize: 11, lineHeight: 1.6,
                    padding: 12, borderRadius: T.radius.sm,
                    border: `1px solid ${screenDirty ? T.status.amber : T.border.default}`,
                    background: T.bg.primary, color: T.text.primary,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <VariableReferencePanel
                agentType="screening"
                textareaRef={screenTextareaRef}
                promptValue={screenParsed.systemPrompt}
                onInsert={setScreenSystemPart}
              />
              <ContentBlocksEditor
                blocks={screenParsed.blocks}
                onChange={setScreenBlocks}
                agentType="screening"
              />
            </>
          )}
        </div>

        {/* Missing variable warnings (shown after save) */}
        {saveWarnings.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px',
            borderRadius: T.radius.sm, background: '#FEF3C710',
            border: `1px solid ${T.status.amber}30`,
          }}>
            <AlertTriangle size={14} color={T.status.amber} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 11, color: T.text.secondary, fontFamily: T.font.sans, lineHeight: 1.5 }}>
              {saveWarnings.map((w, i) => (
                <div key={i} style={{ fontFamily: T.font.sans }}>
                  <span style={{ fontWeight: 600, color: T.status.amber }}>{w}</span>
                  {i === saveWarnings.length - 1 && (
                    <span style={{ color: T.text.tertiary }}> — the system will auto-append missing essentials.</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Inline essential-variable hints (live, per-prompt) */}
        {expandedCoord && coordPrompt && <MissingVariableWarning promptText={coordPrompt} />}
        {expandedScreen && screenPrompt && <MissingVariableWarning promptText={screenPrompt} />}

        {/* Version History */}
        <div style={{ borderTop: `1px solid ${T.border.default}`, paddingTop: 12 }}>
          <button
            onClick={async () => {
              if (!historyOpen && history.length === 0) {
                setHistoryLoading(true)
                try {
                  const data = await apiGetPromptHistory()
                  setHistory(data.history as any[])
                } catch { /* ignore */ }
                setHistoryLoading(false)
              }
              setHistoryOpen(!historyOpen)
            }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontSize: 12, fontWeight: 600, fontFamily: T.font.sans, color: T.text.secondary,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ transform: historyOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
            Version History ({config.systemPromptVersion} current)
          </button>
          {historyOpen && (
            <div style={{ marginTop: 8 }}>
              {historyLoading && <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>Loading...</span>}
              {!historyLoading && history.length === 0 && (
                <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>No previous versions saved yet. History starts from next save.</span>
              )}
              {!historyLoading && history.slice().reverse().map((entry, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 12px', borderRadius: T.radius.sm,
                  background: i % 2 === 0 ? T.bg.primary : T.bg.card,
                  marginBottom: 2,
                }}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 600, fontFamily: T.font.sans, color: T.text.primary }}>
                      v{entry.version}
                    </span>
                    <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans, marginLeft: 8 }}>
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                    <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.sans, marginLeft: 8 }}>
                      {entry.coordinator ? 'coordinator' : ''}{entry.coordinator && entry.screening ? ' + ' : ''}{entry.screening ? 'screening' : ''}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      if (entry.coordinator) setCoordPrompt(entry.coordinator)
                      if (entry.screening) setScreenPrompt(entry.screening)
                      setToast({ type: 'success', message: `Restored v${entry.version} — save to apply` })
                      setTimeout(() => setToast(null), 3000)
                    }}
                    style={{
                      padding: '3px 10px', borderRadius: T.radius.sm,
                      background: T.bg.primary, border: `1px solid ${T.border.default}`,
                      fontSize: 10, fontWeight: 600, fontFamily: T.font.sans,
                      color: T.text.secondary, cursor: 'pointer',
                    }}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            style={{
              padding: '8px 20px', borderRadius: T.radius.sm,
              background: !hasChanges ? T.bg.tertiary : saving ? T.bg.tertiary : T.accent,
              color: !hasChanges ? T.text.tertiary : saving ? T.text.secondary : '#fff',
              border: 'none', cursor: !hasChanges ? 'not-allowed' : saving ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 600, fontFamily: T.font.sans,
              transition: 'background 0.2s',
            }}
          >
            {saving ? 'Saving...' : hasChanges ? 'Save Prompts' : 'No Changes'}
          </button>
          {toast && (
            <span style={{ fontSize: 13, color: toast.type === 'success' ? T.status.green : T.status.red, fontFamily: T.font.sans }}>
              {toast.message}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}


// ─── Image Handling Instructions ──────────────────────────────────────────────

const DEFAULT_IMAGE_HANDLING_TEXT = `[System: The guest sent an image. Follow these rules:]
1. Respond naturally based on what you see — don't describe the image back to the guest.
2. Always escalate to manager. In the escalation note, describe what the image shows.
3. If unclear: tell the guest you're looking into it and escalate.
Common types: broken items → maintenance escalation, leaks/damage → urgent repair, passport/ID → call mark_document_received if document checklist has pending items (otherwise visitor verification escalation), marriage certificate → same, appliance issues → troubleshooting escalation.
Never ignore images.`

function ImageHandlingSection({
  config,
  onChange,
}: {
  config: TenantAiConfig
  onChange: (c: TenantAiConfig) => void
}): React.ReactElement {
  const [value, setValue] = useState((config as any).imageHandlingInstructions || '')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [expanded, setExpanded] = useState(false)

  const hasChanges = value !== ((config as any).imageHandlingInstructions || '')
  const isDefault = !value.trim()

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const updated = await apiUpdateTenantAiConfig({ imageHandlingInstructions: value || null } as any)
      onChange(updated)
      setToast({ type: 'success', message: 'Saved' })
      setTimeout(() => setToast(null), 2000)
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Save failed' })
    }
    setSaving(false)
  }

  return (
    <div style={{ background: T.bg.card, borderRadius: T.radius.lg, border: `1px solid ${T.border.default}`, boxShadow: T.shadow.sm, overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${T.border.default}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: T.radius.sm, background: '#EA580C18', border: '1px solid #EA580C28', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 14 }}>
            📷
          </div>
          <div>
            <span style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>Image Handling</span>
            <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>
              Appended to system prompt when guest sends an image {isDefault ? '(using default)' : '(customized)'}
            </div>
          </div>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            padding: '4px 10px', borderRadius: T.radius.sm,
            background: T.bg.primary, border: `1px solid ${T.border.default}`,
            fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
            color: T.text.secondary, cursor: 'pointer',
          }}
        >
          {expanded ? 'Collapse' : 'Edit'}
        </button>
      </div>
      {expanded && (
        <div style={{ padding: '16px 20px' }}>
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={DEFAULT_IMAGE_HANDLING_TEXT}
            rows={8}
            style={{
              width: '100%', padding: 12, fontSize: 12, fontFamily: T.font.mono,
              border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm,
              background: T.bg.primary, resize: 'vertical', lineHeight: 1.5,
              boxSizing: 'border-box' as const,
            }}
            className="listings-textarea"
          />
          <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans, marginTop: 4 }}>
            {value.length} chars · {isDefault ? 'Empty = uses default instructions' : 'Custom'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              style={{
                padding: '6px 16px', borderRadius: T.radius.sm,
                background: !hasChanges ? T.bg.tertiary : T.accent,
                color: !hasChanges ? T.text.tertiary : '#fff',
                border: 'none', cursor: !hasChanges ? 'not-allowed' : 'pointer',
                fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
              }}
            >
              {saving ? 'Saving...' : hasChanges ? 'Save' : 'No Changes'}
            </button>
            {value.trim() && (
              <button
                onClick={() => setValue('')}
                style={{
                  padding: '6px 12px', borderRadius: T.radius.sm,
                  background: 'transparent', border: `1px solid ${T.border.default}`,
                  fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
                  color: T.text.secondary, cursor: 'pointer',
                }}
              >
                Reset to Default
              </button>
            )}
            {toast && (
              <span style={{ fontSize: 12, color: toast.type === 'success' ? T.status.green : T.status.red, fontFamily: T.font.sans }}>
                {toast.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── General Settings ────────────────────────────────────────────────────────

function GeneralSettings({
  debounceDelayMs,
  onChange,
}: {
  debounceDelayMs: number
  onChange: (ms: number) => void
}): React.ReactElement {
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [localSeconds, setLocalSeconds] = useState(Math.round(debounceDelayMs / 1000))

  function showToast(type: 'success' | 'error', message: string): void {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2000)
  }

  async function handleSave(): Promise<void> {
    const ms = localSeconds * 1000
    setSaving(true)
    try {
      await apiUpdateAIConfig({ debounceDelayMs: ms })
      onChange(ms)
      showToast('success', 'Settings saved')
    } catch {
      showToast('error', 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const cardStyle: React.CSSProperties = {
    borderRadius: T.radius.lg,
    border: `1px solid ${T.border.default}`,
    background: T.bg.primary,
    marginBottom: 16,
    boxShadow: T.shadow.md,
    overflow: 'hidden',
    animation: 'fadeInUp 0.4s ease-out both',
  }

  const inputStyle: React.CSSProperties = {
    width: 90,
    padding: '8px 12px',
    borderRadius: T.radius.sm,
    border: `1px solid ${T.border.default}`,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: T.font.mono,
    color: T.text.primary,
    background: T.bg.secondary,
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  }

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div
        style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${T.border.default}`,
          background: T.bg.secondary,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: T.radius.sm,
            background: '#6B728018',
            border: '1px solid #6B728028',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
          </svg>
        </div>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, letterSpacing: '-0.01em' }}>
            General Settings
          </span>
          <p style={{ fontSize: 12, color: T.text.secondary, margin: '2px 0 0', fontFamily: T.font.sans }}>
            Global settings that apply across all AI personas
          </p>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: 20 }}>
        {/* AI Reply Delay */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 600,
              color: T.text.secondary,
              fontFamily: T.font.sans,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            AI Reply Delay
          </label>
          <p style={{ fontSize: 12, color: T.text.tertiary, margin: '0 0 10px', fontFamily: T.font.sans, lineHeight: 1.5 }}>
            How long to wait after the last guest message before the AI sends a reply. Useful for letting guests send multiple messages before the AI responds.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={localSeconds}
              onChange={e => setLocalSeconds(Math.max(5, Math.min(600, parseInt(e.target.value, 10) || 5)))}
              onFocus={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.boxShadow = `0 0 0 3px ${T.accent}18` }}
              onBlur={e => { e.currentTarget.style.borderColor = T.border.default; e.currentTarget.style.boxShadow = 'none' }}
              style={inputStyle}
            />
            <span style={{ fontSize: 13, color: T.text.secondary, fontFamily: T.font.sans }}>seconds</span>
            <div
              style={{
                marginLeft: 4,
                fontSize: 11,
                color: T.text.tertiary,
                fontFamily: T.font.sans,
                background: T.bg.secondary,
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                padding: '4px 10px',
              }}
            >
              {localSeconds < 60
                ? `${localSeconds}s`
                : `${Math.floor(localSeconds / 60)}m ${localSeconds % 60 > 0 ? `${localSeconds % 60}s` : ''}`}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4, borderTop: `1px solid ${T.border.default}` }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              marginTop: 14,
              background: saving ? T.text.tertiary : T.accent,
              color: '#FFFFFF',
              border: 'none',
              borderRadius: T.radius.sm,
              padding: '9px 20px',
              fontSize: 12,
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
              fontFamily: T.font.sans,
              transition: 'background 0.2s ease, opacity 0.2s ease',
              boxShadow: T.shadow.sm,
            }}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {toast && (
            <span
              style={{
                marginTop: 14,
                fontSize: 12,
                fontWeight: 500,
                color: toast.type === 'success' ? T.status.green : T.status.red,
                fontFamily: T.font.sans,
                animation: 'fadeInUp 0.2s ease-out',
              }}
            >
              {toast.message}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Escalation Settings (C5) ───────────────────────────────────────────────

function EscalationSettings({
  escalation,
  onChange,
}: {
  escalation: { confidenceThreshold: number; triggerKeywords: string[]; maxConsecutiveAiReplies: number }
  onChange: (next: { confidenceThreshold: number; triggerKeywords: string[]; maxConsecutiveAiReplies: number }) => void
}): React.ReactElement {
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [keywordInput, setKeywordInput] = useState('')

  function showToast(type: 'success' | 'error', message: string): void {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2000)
  }

  function handleAddKeyword(raw: string): void {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
    const existing = new Set(escalation.triggerKeywords)
    const added = parts.filter(p => !existing.has(p))
    if (added.length > 0) {
      onChange({ ...escalation, triggerKeywords: [...escalation.triggerKeywords, ...added] })
    }
    setKeywordInput('')
  }

  function handleRemoveKeyword(index: number): void {
    onChange({
      ...escalation,
      triggerKeywords: escalation.triggerKeywords.filter((_, i) => i !== index),
    })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      handleAddKeyword(keywordInput)
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      await apiUpdateAIConfig({ escalation })
      showToast('success', 'Escalation settings saved')
    } catch (err) {
      showToast('error', `Error: ${err instanceof Error ? err.message : 'Failed to save'}`)
    } finally {
      setSaving(false)
    }
  }

  const cardHeaderStyle: React.CSSProperties = {
    background: T.bg.secondary,
    padding: '10px 20px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: T.text.secondary,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderBottom: `1px solid ${T.border.default}`,
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    color: T.text.secondary,
    marginBottom: 6,
    fontFamily: T.font.sans,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  }

  const fieldStyle: React.CSSProperties = {
    marginBottom: 20,
  }

  return (
    <div style={{
      borderRadius: T.radius.lg,
      border: `1px solid ${T.border.default}`,
      background: T.bg.primary,
      overflow: 'hidden',
      marginTop: 24,
      boxShadow: T.shadow.md,
      animation: 'fadeInUp 0.4s ease-out both',
      animationDelay: '0.4s',
    }}>
      <div style={cardHeaderStyle}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: T.status.amber, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <AlertTriangle size={11} style={{ color: '#FFFFFF' }} />
        </div>
        Escalation Settings
      </div>
      <div style={{ padding: 20 }}>
        {/* Confidence Threshold */}
        <div style={fieldStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>Confidence Threshold</label>
            <span style={{
              background: T.bg.tertiary,
              borderRadius: T.radius.sm,
              padding: '2px 10px',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: T.font.mono,
              color: T.text.primary,
              minWidth: 42,
              textAlign: 'center',
            }}>
              {escalation.confidenceThreshold}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={escalation.confidenceThreshold}
            onChange={e => onChange({ ...escalation, confidenceThreshold: parseInt(e.target.value, 10) })}
            style={{
              width: '100%',
              cursor: 'pointer',
              accentColor: T.status.amber,
              height: 6,
            }}
          />
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 10,
            color: T.text.tertiary,
            marginTop: 4,
            fontFamily: T.font.mono,
          }}>
            <span>0 Always escalate</span>
            <span>100 Never escalate</span>
          </div>
        </div>

        {/* Trigger Keywords */}
        <div style={fieldStyle}>
          <label style={labelStyle}>Trigger Keywords</label>
          {escalation.triggerKeywords.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {escalation.triggerKeywords.map((kw, i) => (
                <span
                  key={i}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    background: T.bg.secondary,
                    border: `1px solid ${T.border.default}`,
                    borderRadius: 999,
                    padding: '3px 10px',
                    fontSize: 12,
                    fontFamily: T.font.sans,
                    color: T.text.primary,
                    boxShadow: T.shadow.sm,
                    transition: 'box-shadow 0.15s ease',
                  }}
                >
                  {kw}
                  <button
                    onClick={() => handleRemoveKeyword(i)}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = T.status.red }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = T.text.tertiary }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      lineHeight: 1,
                      color: T.text.tertiary,
                      fontSize: 13,
                      display: 'inline-flex',
                      alignItems: 'center',
                      transition: 'color 0.12s ease',
                    }}
                    aria-label={`Remove keyword "${kw}"`}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            type="text"
            value={keywordInput}
            onChange={e => setKeywordInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => { if (keywordInput.trim()) handleAddKeyword(keywordInput) }}
            placeholder="Type keyword and press Enter (e.g. refund, lawyer, complaint)"
            style={{
              width: '100%',
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              padding: '8px 12px',
              fontSize: 13,
              fontFamily: T.font.sans,
              background: T.bg.secondary,
              color: T.text.primary,
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease',
            }}
            onFocus={e => { e.currentTarget.style.boxShadow = `0 0 0 2px rgba(29,78,216,0.15)`; e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.background = T.bg.primary }}
            onBlurCapture={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = T.border.default; e.currentTarget.style.background = T.bg.secondary }}
          />
        </div>

        {/* Max Consecutive AI Replies */}
        <div style={fieldStyle}>
          <label style={labelStyle}>Max Consecutive AI Replies</label>
          <input
            type="number"
            min={1}
            max={20}
            value={escalation.maxConsecutiveAiReplies}
            onChange={e => {
              const v = parseInt(e.target.value, 10)
              if (!isNaN(v) && v >= 1 && v <= 20) {
                onChange({ ...escalation, maxConsecutiveAiReplies: v })
              }
            }}
            style={{
              width: 110,
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              padding: '8px 12px',
              fontSize: 14,
              fontWeight: 600,
              background: T.bg.primary,
              color: T.text.primary,
              outline: 'none',
              fontFamily: T.font.mono,
              boxSizing: 'border-box',
              transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
              textAlign: 'center',
            }}
            onFocus={e => { e.currentTarget.style.boxShadow = `0 0 0 2px rgba(29,78,216,0.15)`; e.currentTarget.style.borderColor = T.accent }}
            onBlur={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = T.border.default }}
          />
          <div style={{
            fontSize: 11,
            color: T.text.tertiary,
            marginTop: 6,
            fontFamily: T.font.sans,
            lineHeight: 1.4,
          }}>
            Escalate to host after this many consecutive AI replies without guest resolution.
          </div>
        </div>

        {/* Save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            onMouseEnter={e => { if (!saving) { (e.currentTarget as HTMLButtonElement).style.background = '#2D2926'; (e.currentTarget as HTMLButtonElement).style.boxShadow = T.shadow.md } }}
            onMouseLeave={e => { if (!saving) { (e.currentTarget as HTMLButtonElement).style.background = T.border.strong; (e.currentTarget as HTMLButtonElement).style.boxShadow = T.shadow.sm } }}
            style={{
              background: T.border.strong,
              color: '#FFFFFF',
              border: 'none',
              borderRadius: T.radius.sm,
              padding: '9px 20px',
              fontSize: 12,
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.5 : 1,
              fontFamily: T.font.sans,
              transition: 'background 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease',
              boxShadow: T.shadow.sm,
            }}
          >
            {saving ? 'Saving...' : 'Save Escalation Settings'}
          </button>

          {toast && (
            <span style={{
              fontSize: 12,
              fontWeight: 500,
              color: toast.type === 'success' ? T.status.green : T.status.red,
              fontFamily: T.font.sans,
              animation: 'fadeInUp 0.2s ease-out',
            }}>
              {toast.message}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Version History (C3) ───────────────────────────────────────────────────

function VersionHistory({
  configVersion,
  onRevert,
}: {
  configVersion: number
  onRevert: () => void
}): React.ReactElement {
  const [versions, setVersions] = useState<AiConfigVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [reverting, setReverting] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  function showToast(type: 'success' | 'error', message: string): void {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2000)
  }

  useEffect(() => {
    apiGetAiConfigVersions()
      .then(data => {
        setVersions(data.slice(0, 10))
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
      })
  }, [configVersion])

  async function handleRevert(id: string): Promise<void> {
    setReverting(id)
    try {
      await apiRevertAiConfigVersion(id)
      showToast('success', 'Reverted successfully')
      onRevert()
    } catch (err) {
      showToast('error', `Error: ${err instanceof Error ? err.message : 'Revert failed'}`)
    } finally {
      setReverting(null)
    }
  }

  function formatVersionDate(iso: string): string {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const cardHeaderStyle: React.CSSProperties = {
    background: T.bg.secondary,
    padding: '10px 20px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: T.text.secondary,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderBottom: `1px solid ${T.border.default}`,
  }

  return (
    <div style={{
      borderRadius: T.radius.lg,
      border: `1px solid ${T.border.default}`,
      background: T.bg.primary,
      overflow: 'hidden',
      marginTop: 24,
      marginBottom: 48,
      boxShadow: T.shadow.md,
      animation: 'fadeInUp 0.4s ease-out both',
      animationDelay: '0.45s',
    }}>
      <div style={cardHeaderStyle}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: T.text.secondary, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <History size={11} style={{ color: '#FFFFFF' }} />
        </div>
        Version History
      </div>
      <div style={{ padding: 20 }}>
        {toast && (
          <div style={{
            fontSize: 12,
            fontWeight: 500,
            color: toast.type === 'success' ? T.status.green : T.status.red,
            fontFamily: T.font.sans,
            marginBottom: 12,
            animation: 'fadeInUp 0.2s ease-out',
          }}>
            {toast.message}
          </div>
        )}

        {loading ? (
          <div style={{
            fontSize: 12,
            color: T.text.tertiary,
            fontFamily: T.font.sans,
            padding: '8px 0',
          }}>
            Loading versions...
          </div>
        ) : versions.length === 0 ? (
          <div style={{
            fontSize: 12,
            color: T.text.tertiary,
            fontFamily: T.font.sans,
            background: T.bg.secondary,
            padding: 16,
            borderRadius: T.radius.md,
            border: `1px dashed ${T.border.default}`,
            lineHeight: 1.5,
          }}>
            No version history yet. Versions are created each time you save a config change.
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            {/* Timeline line */}
            <div style={{
              position: 'absolute',
              left: 15,
              top: 8,
              bottom: 8,
              width: 2,
              background: T.border.default,
              borderRadius: 1,
            }} />
            {versions.map((v, i) => (
              <div
                key={v.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '10px 0 10px 36px',
                  gap: 12,
                  position: 'relative',
                }}
              >
                {/* Timeline dot */}
                <div style={{
                  position: 'absolute',
                  left: 10,
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: i === 0 ? T.status.green : T.bg.primary,
                  border: `2px solid ${i === 0 ? T.status.green : T.border.default}`,
                  boxShadow: i === 0 ? `0 0 0 3px rgba(21,128,61,0.15)` : 'none',
                }} />
                <span style={{
                  fontSize: 12,
                  fontWeight: 700,
                  fontFamily: T.font.mono,
                  color: i === 0 ? T.text.primary : T.text.secondary,
                  minWidth: 36,
                  background: i === 0 ? T.bg.tertiary : 'transparent',
                  borderRadius: 4,
                  padding: '1px 4px',
                  textAlign: 'center',
                }}>
                  v{v.version}
                </span>
                <span style={{
                  flex: 1,
                  fontSize: 12,
                  color: T.text.secondary,
                  fontFamily: T.font.mono,
                }}>
                  {formatVersionDate(v.createdAt)}
                  {v.note && (
                    <span style={{ color: T.text.tertiary, marginLeft: 8, fontStyle: 'italic', fontFamily: T.font.sans }}>
                      {v.note}
                    </span>
                  )}
                </span>
                {i > 0 && (
                  <button
                    onClick={() => handleRevert(v.id)}
                    disabled={reverting === v.id}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = T.bg.tertiary; (e.currentTarget as HTMLButtonElement).style.borderColor = T.text.secondary }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = T.bg.secondary; (e.currentTarget as HTMLButtonElement).style.borderColor = T.border.default }}
                    style={{
                      background: T.bg.secondary,
                      border: `1px solid ${T.border.default}`,
                      borderRadius: T.radius.sm,
                      padding: '4px 12px',
                      fontSize: 11,
                      fontWeight: 600,
                      color: T.text.secondary,
                      cursor: reverting === v.id ? 'not-allowed' : 'pointer',
                      fontFamily: T.font.sans,
                      opacity: reverting === v.id ? 0.5 : 1,
                      transition: 'background 0.15s ease, opacity 0.15s ease, border-color 0.15s ease',
                    }}
                  >
                    {reverting === v.id ? 'Reverting...' : 'Revert'}
                  </button>
                )}
                {i === 0 && (
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: T.status.green,
                    fontFamily: T.font.sans,
                    textTransform: 'uppercase' as const,
                    letterSpacing: '0.06em',
                    background: 'rgba(21,128,61,0.08)',
                    borderRadius: 999,
                    padding: '2px 10px',
                  }}>
                    Current
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
