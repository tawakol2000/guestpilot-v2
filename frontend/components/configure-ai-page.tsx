'use client'

import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, Check, AlertCircle, Code, X, Plus, Settings, FileJson } from 'lucide-react'
import {
  apiGetAIConfig,
  apiUpdateAIConfig,
  type AiConfig,
  type AiPersonaConfig,
} from '@/lib/api'

// ─── Model options ─────────────────────────────────────────────────────────────
const MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fast & economical' },
  { value: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', description: 'Balanced' },
  { value: 'claude-opus-4-6',           label: 'Opus 4.6',   description: 'Most capable' },
]

// ─── Persona definitions ──────────────────────────────────────────────────────
const PERSONAS: {
  key: keyof AiConfig
  name: string
  description: string
  accentColor: string
  accentBg: string
  accentLight: string
}[] = [
  {
    key: 'guestCoordinator',
    name: 'Guest Coordinator',
    description: 'Responds to confirmed reservation guests automatically',
    accentColor: '#D97B4F',
    accentBg: 'rgba(217,123,79,0.06)',
    accentLight: 'rgba(217,123,79,0.12)',
  },
  {
    key: 'screeningAI',
    name: 'Screening AI',
    description: 'Screens and responds to pre-booking inquiries',
    accentColor: '#2C7BE5',
    accentBg: 'rgba(44,123,229,0.05)',
    accentLight: 'rgba(44,123,229,0.10)',
  },
  {
    key: 'managerTranslator',
    name: 'Manager Translator',
    description: 'Polishes your quick notes into guest-ready messages (Send Through AI)',
    accentColor: '#D4A017',
    accentBg: 'rgba(212,160,23,0.05)',
    accentLight: 'rgba(212,160,23,0.12)',
  },
]

// ─── Loading skeleton ─────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04)', overflow: 'hidden', display: 'flex' }}>
      <div style={{ width: 4, background: '#E5E5EA', flexShrink: 0 }} />
      <div style={{ padding: '20px 24px', flex: 1 }}>
        <div style={{ width: 140, height: 14, background: '#F2F2F7', borderRadius: 6, marginBottom: 8 }} />
        <div style={{ width: 220, height: 11, background: '#F2F2F7', borderRadius: 6, marginBottom: 20 }} />
        <div style={{ height: 1, background: 'var(--border)', marginBottom: 20 }} />
        <div style={{ width: '60%', height: 11, background: '#F2F2F7', borderRadius: 6, marginBottom: 12 }} />
        <div style={{ width: '80%', height: 11, background: '#F2F2F7', borderRadius: 6 }} />
      </div>
    </div>
  )
}

// ─── Reusable field label ─────────────────────────────────────────────────────
function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted-foreground)' }}>
        {children}
      </label>
      {hint && <p style={{ fontSize: 10, color: 'var(--muted-foreground)', margin: '3px 0 0', opacity: 0.75 }}>{hint}</p>}
    </div>
  )
}

// ─── Stop sequences tag input ─────────────────────────────────────────────────
function StopSequencesInput({
  value,
  onChange,
  accentColor,
}: {
  value: string[]
  onChange: (v: string[]) => void
  accentColor: string
}) {
  const [input, setInput] = useState('')

  function addTag() {
    const trimmed = input.trim()
    if (!trimmed || value.includes(trimmed)) return
    onChange([...value, trimmed])
    setInput('')
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5" style={{ marginBottom: value.length ? 8 : 0 }}>
        {value.map((seq, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 text-[11px] font-medium"
            style={{
              background: accentColor + '15',
              color: accentColor,
              borderRadius: 6,
              padding: '3px 6px 3px 8px',
              border: `1px solid ${accentColor}30`,
            }}
          >
            <code style={{ fontFamily: 'monospace', fontSize: 10 }}>{JSON.stringify(seq)}</code>
            <button
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: accentColor, opacity: 0.7 }}
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
          placeholder="e.g. \n or END"
          style={{
            flex: 1,
            padding: '6px 10px',
            borderRadius: 8,
            border: '1.5px solid var(--border)',
            background: '#FAFAFA',
            fontSize: 11,
            color: 'var(--brown-dark)',
            outline: 'none',
            fontFamily: 'monospace',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = accentColor }}
          onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
        />
        <button
          onClick={addTag}
          disabled={!input.trim()}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: `1.5px solid ${accentColor}40`,
            background: accentColor + '10',
            color: accentColor,
            fontSize: 11,
            fontWeight: 600,
            cursor: input.trim() ? 'pointer' : 'not-allowed',
            opacity: input.trim() ? 1 : 0.4,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Plus size={11} /> Add
        </button>
      </div>
    </div>
  )
}

// ─── Per-persona card ─────────────────────────────────────────────────────────
function PersonaCard({
  persona,
  config,
  onChange,
}: {
  persona: typeof PERSONAS[number]
  config: AiPersonaConfig
  onChange: (next: AiPersonaConfig) => void
}) {
  const [promptOpen, setPromptOpen] = useState(false)
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonErr, setJsonErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  // Sync JSON text when switching to JSON mode
  function enterJsonMode() {
    setJsonText(JSON.stringify(config, null, 2))
    setJsonErr(null)
    setJsonMode(true)
  }

  function exitJsonMode() {
    // Try to apply JSON changes
    try {
      const parsed = JSON.parse(jsonText) as AiPersonaConfig
      if (!parsed.model || !parsed.systemPrompt || typeof parsed.temperature !== 'number' || typeof parsed.maxTokens !== 'number') {
        setJsonErr('Missing required fields: model, temperature, maxTokens, systemPrompt')
        return
      }
      onChange(parsed)
      setJsonMode(false)
    } catch {
      setJsonErr('Invalid JSON')
    }
  }

  async function handleSave() {
    // If in JSON mode, apply JSON first
    if (jsonMode) {
      try {
        const parsed = JSON.parse(jsonText) as AiPersonaConfig
        if (!parsed.model || !parsed.systemPrompt) {
          setSaveErr('Invalid config: missing required fields')
          setTimeout(() => setSaveErr(null), 3000)
          return
        }
        onChange(parsed)
      } catch {
        setSaveErr('Invalid JSON — fix before saving')
        setTimeout(() => setSaveErr(null), 3000)
        return
      }
    }
    setSaving(true)
    setSavedOk(false)
    setSaveErr(null)
    try {
      await apiUpdateAIConfig({ [persona.key]: jsonMode ? JSON.parse(jsonText) : config })
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2000)
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : 'Failed to save')
      setTimeout(() => setSaveErr(null), 3000)
    } finally {
      setSaving(false)
    }
  }

  const accent = persona.accentColor

  const inputStyle: React.CSSProperties = {
    padding: '7px 12px',
    borderRadius: 8,
    border: '1.5px solid var(--border)',
    background: '#FAFAFA',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--brown-dark)',
    outline: 'none',
    fontFamily: 'inherit',
  }

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04)',
        overflow: 'hidden',
        display: 'flex',
        flexShrink: 0,
      }}
    >
      <div style={{ width: 4, background: accent, flexShrink: 0 }} />

      <div style={{ flex: 1, padding: '20px 24px' }}>
        {/* Header */}
        <div className="flex items-start justify-between" style={{ marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--brown-dark)', margin: 0, lineHeight: 1.3 }}>
              {persona.name}
            </h2>
            <p style={{ fontSize: 11, color: 'var(--muted-foreground)', margin: '4px 0 0', lineHeight: 1.4 }}>
              {persona.description}
            </p>
          </div>
          {/* View as JSON toggle */}
          <button
            onClick={() => jsonMode ? exitJsonMode() : enterJsonMode()}
            className="flex items-center gap-1.5 shrink-0"
            style={{
              padding: '5px 10px',
              borderRadius: 7,
              border: jsonMode ? `1.5px solid ${accent}` : '1.5px solid var(--border)',
              background: jsonMode ? persona.accentBg : 'transparent',
              color: jsonMode ? accent : 'var(--muted-foreground)',
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <Code size={11} />
            {jsonMode ? 'Exit JSON' : 'View JSON'}
          </button>
        </div>

        <div style={{ height: 1, background: 'var(--border)', margin: '16px 0' }} />

        {jsonMode ? (
          /* ─── JSON editor mode ─── */
          <div>
            <textarea
              value={jsonText}
              onChange={e => { setJsonText(e.target.value); setJsonErr(null) }}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: 400,
                padding: '14px 16px',
                borderRadius: 10,
                border: jsonErr ? '1.5px solid #DC2626' : `1.5px solid ${accent}40`,
                background: '#1E1E2E',
                fontSize: 12,
                fontFamily: '"Berkeley Mono", "Fira Code", "JetBrains Mono", "Cascadia Code", "Courier New", monospace',
                lineHeight: 1.7,
                color: '#CDD6F4',
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
                tabSize: 2,
              }}
            />
            {jsonErr && (
              <div className="flex items-center gap-1.5 mt-2">
                <AlertCircle size={11} style={{ color: '#DC2626' }} />
                <span style={{ fontSize: 11, color: '#DC2626' }}>{jsonErr}</span>
              </div>
            )}
            <p style={{ fontSize: 10, color: 'var(--muted-foreground)', margin: '8px 0 0', lineHeight: 1.5 }}>
              Edit the raw JSON config. All fields sent to the Claude API are available here: model, temperature, maxTokens, topK, topP, stopSequences, systemPrompt.
            </p>
          </div>
        ) : (
          /* ─── Visual editor mode ─── */
          <div className="flex flex-col gap-5">

            {/* Model selector */}
            <div>
              <FieldLabel hint="Which Claude model to use for this persona">Model</FieldLabel>
              <div className="flex gap-2 flex-wrap">
                {MODEL_OPTIONS.map(opt => {
                  const isActive = config.model === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => onChange({ ...config, model: opt.value })}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 1,
                        padding: '8px 14px',
                        borderRadius: 8,
                        border: isActive ? `1.5px solid ${accent}` : '1.5px solid var(--border)',
                        background: isActive ? persona.accentBg : '#FAFAFA',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        minWidth: 105,
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600, color: isActive ? accent : 'var(--brown-dark)' }}>
                        {opt.label}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--muted-foreground)', fontWeight: 400 }}>
                        {opt.description}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Temperature + Top P side by side */}
            <div className="flex gap-6 flex-wrap">
              <div style={{ flex: 1, minWidth: 200 }}>
                <FieldLabel hint="Lower = more deterministic, higher = more creative">Temperature</FieldLabel>
                <div className="flex items-center gap-3">
                  <span style={{ fontSize: 10, color: 'var(--muted-foreground)', width: 40 }}>Precise</span>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={config.temperature}
                    onChange={e => onChange({ ...config, temperature: parseFloat(e.target.value) })}
                    style={{ flex: 1, accentColor: accent, cursor: 'pointer', height: 4 }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--muted-foreground)', width: 40, textAlign: 'right' }}>Creative</span>
                  <span
                    style={{
                      fontSize: 12, fontWeight: 600, color: accent, minWidth: 36, textAlign: 'center',
                      background: persona.accentLight, borderRadius: 6, padding: '2px 6px',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {config.temperature.toFixed(2)}
                  </span>
                </div>
              </div>

              <div style={{ minWidth: 160 }}>
                <FieldLabel hint="Nucleus sampling (optional, 0–1)">Top P</FieldLabel>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={0} max={1} step={0.05}
                    value={config.topP ?? ''}
                    placeholder="—"
                    onChange={e => {
                      const v = e.target.value
                      onChange({ ...config, topP: v === '' ? undefined : parseFloat(v) })
                    }}
                    style={{ ...inputStyle, width: 80 }}
                    onFocus={e => { e.currentTarget.style.borderColor = accent }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--muted-foreground)' }}>0 – 1</span>
                </div>
              </div>
            </div>

            {/* Max Tokens + Top K side by side */}
            <div className="flex gap-6 flex-wrap">
              <div style={{ minWidth: 160 }}>
                <FieldLabel hint="Maximum tokens in the AI response">Max Tokens</FieldLabel>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={64} max={8192} step={64}
                    value={config.maxTokens}
                    onChange={e => onChange({ ...config, maxTokens: parseInt(e.target.value, 10) || config.maxTokens })}
                    style={{ ...inputStyle, width: 110 }}
                    onFocus={e => { e.currentTarget.style.borderColor = accent }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--muted-foreground)' }}>tokens</span>
                </div>
              </div>

              <div style={{ minWidth: 160 }}>
                <FieldLabel hint="Only sample from top K tokens (optional)">Top K</FieldLabel>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} max={500} step={1}
                    value={config.topK ?? ''}
                    placeholder="—"
                    onChange={e => {
                      const v = e.target.value
                      onChange({ ...config, topK: v === '' ? undefined : parseInt(v, 10) })
                    }}
                    style={{ ...inputStyle, width: 80 }}
                    onFocus={e => { e.currentTarget.style.borderColor = accent }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                  />
                </div>
              </div>
            </div>

            {/* Stop sequences */}
            <div>
              <FieldLabel hint="Sequences that stop generation when encountered (optional)">Stop Sequences</FieldLabel>
              <StopSequencesInput
                value={config.stopSequences || []}
                onChange={v => onChange({ ...config, stopSequences: v.length ? v : undefined })}
                accentColor={accent}
              />
            </div>

            {/* System Prompt — collapsible */}
            <div>
              <button
                onClick={() => setPromptOpen(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  background: 'none', border: 'none', padding: '0 0 8px', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted-foreground)', flex: 1 }}>
                  System Instructions
                </span>
                {!promptOpen && (
                  <span style={{ fontSize: 10, color: 'var(--muted-foreground)', fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
                    {config.systemPrompt.length.toLocaleString()} chars
                  </span>
                )}
                {promptOpen
                  ? <ChevronUp size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                  : <ChevronDown size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                }
              </button>

              {promptOpen && (
                <div>
                  <textarea
                    value={config.systemPrompt}
                    onChange={e => onChange({ ...config, systemPrompt: e.target.value })}
                    spellCheck={false}
                    style={{
                      width: '100%', minHeight: 360, padding: '14px 16px', borderRadius: 10,
                      border: `1.5px solid ${accent}40`, background: '#F8F8FA',
                      fontSize: 12.5,
                      fontFamily: '"Berkeley Mono", "Fira Code", "JetBrains Mono", "Cascadia Code", "Courier New", monospace',
                      lineHeight: 1.7, color: 'var(--brown-dark)', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                      transition: 'border-color 0.15s',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = accent }}
                    onBlur={e => { e.currentTarget.style.borderColor = `${accent}40` }}
                  />
                  <div className="flex justify-end mt-1.5">
                    <span style={{ fontSize: 10, color: 'var(--muted-foreground)', fontVariantNumeric: 'tabular-nums' }}>
                      {config.systemPrompt.length.toLocaleString()} characters
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Response Schema */}
            <div>
              <FieldLabel hint="Expected JSON output format the AI must respond in">
                <span className="flex items-center gap-1.5"><FileJson size={10} /> Response Schema</span>
              </FieldLabel>
              <textarea
                value={config.responseSchema || ''}
                onChange={e => onChange({ ...config, responseSchema: e.target.value })}
                spellCheck={false}
                placeholder='e.g. {"guest_message":"...","escalation":{...}|null}'
                style={{
                  width: '100%', minHeight: 80, padding: '10px 14px', borderRadius: 8,
                  border: `1.5px solid ${accent}30`, background: '#1E1E2E',
                  fontSize: 11.5,
                  fontFamily: '"Berkeley Mono", "Fira Code", "JetBrains Mono", monospace',
                  lineHeight: 1.7, color: '#CDD6F4', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = accent }}
                onBlur={e => { e.currentTarget.style.borderColor = `${accent}30` }}
              />
            </div>

            {/* Content Block Template */}
            <div>
              <FieldLabel hint="Template with {{variables}} for the content blocks sent to Claude">Content Block Template</FieldLabel>
              <textarea
                value={config.contentBlockTemplate || ''}
                onChange={e => onChange({ ...config, contentBlockTemplate: e.target.value })}
                spellCheck={false}
                placeholder={'### CONVERSATION HISTORY ###\n{{conversationHistory}}\n\n### PROPERTY & GUEST INFO ###\n{{propertyInfo}}'}
                style={{
                  width: '100%', minHeight: 120, padding: '10px 14px', borderRadius: 8,
                  border: `1.5px solid ${accent}30`, background: '#F8F8FA',
                  fontSize: 11.5,
                  fontFamily: '"Berkeley Mono", "Fira Code", "JetBrains Mono", monospace',
                  lineHeight: 1.7, color: 'var(--brown-dark)', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = accent }}
                onBlur={e => { e.currentTarget.style.borderColor = `${accent}30` }}
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {(persona.key === 'managerTranslator' ? TRANSLATOR_VARS : GUEST_PERSONA_VARS).map(v => (
                  <span
                    key={v}
                    className="text-[10px] font-mono px-2 py-0.5 rounded-md"
                    style={{ background: `${accent}12`, color: accent, border: `1px solid ${accent}25` }}
                  >
                    {'{{' + v + '}}'}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer: save button + status */}
        <div style={{ height: 1, background: 'var(--border)', margin: '20px 0 16px' }} />
        <div className="flex items-center justify-between">
          <div style={{ minHeight: 20 }}>
            {saveErr && (
              <div className="flex items-center gap-1.5">
                <AlertCircle size={12} style={{ color: '#DC2626' }} />
                <span style={{ fontSize: 11, color: '#DC2626' }}>{saveErr}</span>
              </div>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 18px',
              borderRadius: 8, border: 'none',
              background: savedOk ? '#22C55E' : accent,
              color: '#fff', fontSize: 12, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.65 : 1,
              transition: 'background 0.2s, opacity 0.15s',
              fontFamily: 'inherit',
            }}
          >
            {savedOk && <Check size={13} />}
            {saving ? 'Saving…' : savedOk ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page export ─────────────────────────────────────────────────────────
// ─── Variable pills ──────────────────────────────────────────────────────────
const GUEST_PERSONA_VARS = ['conversationHistory', 'propertyInfo', 'currentMessages', 'localTime']
const TRANSLATOR_VARS = ['conversationHistory', 'managerInstruction']

// ─── General Settings card ──────────────────────────────────────────────────
function GeneralSettingsCard({
  debounceDelayMs,
  messageHistoryCount,
  onDebounceChange,
  onMessageCountChange,
  onSave,
}: {
  debounceDelayMs: number
  messageHistoryCount: number
  onDebounceChange: (v: number) => void
  onMessageCountChange: (v: number) => void
  onSave: () => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await onSave()
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2000)
    } catch { /* silent */ }
    finally { setSaving(false) }
  }

  const inputStyle: React.CSSProperties = {
    padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--border)',
    background: '#FAFAFA', fontSize: 12, fontWeight: 500, color: 'var(--brown-dark)',
    outline: 'none', fontFamily: 'inherit', width: 110,
  }

  return (
    <div style={{
      background: '#fff', borderRadius: 12, overflow: 'hidden', display: 'flex', flexShrink: 0,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04)',
    }}>
      <div style={{ width: 4, background: '#6B7280', flexShrink: 0 }} />
      <div style={{ flex: 1, padding: '20px 24px' }}>
        <div className="flex items-center gap-2 mb-1">
          <Settings size={14} style={{ color: '#6B7280' }} />
          <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--brown-dark)', margin: 0 }}>General Settings</h2>
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted-foreground)', margin: '4px 0 16px' }}>
          Global AI settings that apply across all personas.
        </p>

        <div className="flex gap-6 flex-wrap">
          <div style={{ minWidth: 180 }}>
            <FieldLabel hint="Wait time after last guest message before AI replies">Debounce Delay</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                type="number" min={10} max={600} step={10}
                value={Math.round(debounceDelayMs / 1000)}
                onChange={e => onDebounceChange(parseInt(e.target.value, 10) * 1000 || debounceDelayMs)}
                style={inputStyle}
                onFocus={e => { e.currentTarget.style.borderColor = '#6B7280' }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
              />
              <span style={{ fontSize: 10, color: 'var(--muted-foreground)' }}>seconds</span>
            </div>
          </div>

          <div style={{ minWidth: 180 }}>
            <FieldLabel hint="Number of recent messages sent as context to AI">Message History Count</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                type="number" min={5} max={100} step={5}
                value={messageHistoryCount}
                onChange={e => onMessageCountChange(parseInt(e.target.value, 10) || messageHistoryCount)}
                style={inputStyle}
                onFocus={e => { e.currentTarget.style.borderColor = '#6B7280' }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
              />
              <span style={{ fontSize: 10, color: 'var(--muted-foreground)' }}>messages</span>
            </div>
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--border)', margin: '20px 0 16px' }} />
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 18px',
              borderRadius: 8, border: 'none',
              background: savedOk ? '#22C55E' : '#6B7280',
              color: '#fff', fontSize: 12, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.65 : 1,
              transition: 'background 0.2s, opacity 0.15s', fontFamily: 'inherit',
            }}
          >
            {savedOk && <Check size={13} />}
            {saving ? 'Saving…' : savedOk ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfigureAIPage() {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  useEffect(() => {
    apiGetAIConfig()
      .then(data => { setConfig(data); setLoading(false) })
      .catch(err => { setLoadErr(err instanceof Error ? err.message : 'Failed to load'); setLoading(false) })
  }, [])

  function updatePersona(key: keyof AiConfig, next: AiPersonaConfig) {
    setConfig(prev => prev ? { ...prev, [key]: next } : prev)
  }

  return (
    <div className="flex flex-col h-full" style={{ background: '#fff' }}>
      <div className="flex items-center px-6 shrink-0" style={{ height: 44, borderBottom: '1px solid var(--border)' }}>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--brown-dark)' }}>
          Configure AI
        </span>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loadErr && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
            <AlertCircle size={14} style={{ color: '#DC2626', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: '#DC2626' }}>{loadErr}</span>
          </div>
        )}

        {loading ? (
          <><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></>
        ) : config ? (
          <>
            {/* General Settings */}
            <GeneralSettingsCard
              debounceDelayMs={config.debounceDelayMs ?? 120000}
              messageHistoryCount={config.messageHistoryCount ?? 20}
              onDebounceChange={v => setConfig(prev => prev ? { ...prev, debounceDelayMs: v } : prev)}
              onMessageCountChange={v => setConfig(prev => prev ? { ...prev, messageHistoryCount: v } : prev)}
              onSave={async () => {
                await apiUpdateAIConfig({
                  debounceDelayMs: config.debounceDelayMs,
                  messageHistoryCount: config.messageHistoryCount,
                } as Partial<AiConfig>)
              }}
            />

            <div style={{ marginBottom: 4 }}>
              <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--muted-foreground)', margin: 0 }}>
                AI Personas
              </h3>
              <p style={{ fontSize: 11, color: 'var(--muted-foreground)', marginTop: 4, lineHeight: 1.5 }}>
                Configure model, sampling parameters, system instructions, response schema, and content templates for each AI persona.
              </p>
            </div>

            {PERSONAS.map(persona => (
              <PersonaCard
                key={persona.key}
                persona={persona}
                config={config[persona.key] as AiPersonaConfig}
                onChange={next => updatePersona(persona.key, next)}
              />
            ))}
          </>
        ) : null}
      </div>
    </div>
  )
}
