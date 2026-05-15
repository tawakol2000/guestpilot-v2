'use client'

/**
 * Studio provider toggle — flips the BUILD+TUNE agent between Claude
 * (Anthropic SDK) and gpt-5.4-mini (OpenAI Responses API) per turn.
 *
 * The selection lives in localStorage under `studio.provider` so it
 * survives reloads, and is read at request time by the studio-chat
 * transport's `body:` factory. No frontend rerender is needed when the
 * user flips it — the very next message picks up the new value because
 * the factory re-reads on every send.
 *
 * Defaults to `anthropic` (matches the backend env default).
 */

import { useEffect, useState } from 'react'
import { STUDIO_TOKENS_V2 } from './tokens'

export type StudioProviderChoice = 'anthropic' | 'openai'

const STORAGE_KEY = 'studio.provider'
const EVENT_NAME = 'studio:provider-change'

/** Read current choice synchronously (SSR-safe — returns default). */
export function readStudioProvider(): StudioProviderChoice {
  if (typeof window === 'undefined') return 'anthropic'
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'openai' ? 'openai' : 'anthropic'
  } catch {
    return 'anthropic'
  }
}

function writeStudioProvider(choice: StudioProviderChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice)
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: choice }))
  } catch {
    /* swallow — non-critical UI state */
  }
}

/** React hook for components that want to observe + change the choice. */
export function useStudioProvider(): [StudioProviderChoice, (c: StudioProviderChoice) => void] {
  // 2026-05-15 H10: lazy init reads localStorage synchronously when the
  // component is rendered on the client. The previous version always
  // started at 'anthropic' on SSR and then flipped on first effect,
  // producing a hydration mismatch + visible flicker when the stored
  // value was 'openai'. `typeof window` keeps the SSR pass safe.
  const [choice, setChoice] = useState<StudioProviderChoice>(() =>
    typeof window === 'undefined' ? 'anthropic' : readStudioProvider(),
  )

  useEffect(() => {
    // Re-sync once on mount in case the lazy init ran on a server pass
    // (e.g. components rendered before hydration in the App Router).
    setChoice(readStudioProvider())
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as StudioProviderChoice | undefined
      if (detail === 'openai' || detail === 'anthropic') setChoice(detail)
    }
    window.addEventListener(EVENT_NAME, onChange)
    return () => window.removeEventListener(EVENT_NAME, onChange)
  }, [])

  return [choice, (c) => {
    setChoice(c)
    writeStudioProvider(c)
  }]
}

interface SegmentProps {
  label: string
  active: boolean
  onClick: () => void
}

function Segment({ label, active, onClick }: SegmentProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={`studio-provider-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
      style={{
        height: 22,
        padding: '0 8px',
        borderRadius: 999,
        border: 'none',
        background: active ? STUDIO_TOKENS_V2.surface3 : 'transparent',
        color: active ? STUDIO_TOKENS_V2.ink : STUDIO_TOKENS_V2.muted,
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        cursor: active ? 'default' : 'pointer',
        transition: 'background 120ms ease-out, color 120ms ease-out',
      }}
    >
      {label}
    </button>
  )
}

/**
 * Pill toggle rendered in the Studio top bar's right slot.
 * Two segments: "Claude" | "GPT-5.4". Click to switch.
 */
export function ProviderToggle() {
  const [choice, setChoice] = useStudioProvider()

  return (
    <div
      role="group"
      aria-label="Studio model provider"
      data-testid="studio-provider-toggle"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: 999,
        background: STUDIO_TOKENS_V2.bg,
      }}
    >
      <Segment
        label="Claude"
        active={choice === 'anthropic'}
        onClick={() => setChoice('anthropic')}
      />
      <Segment
        label="GPT-5.4"
        active={choice === 'openai'}
        onClick={() => setChoice('openai')}
      />
    </div>
  )
}
