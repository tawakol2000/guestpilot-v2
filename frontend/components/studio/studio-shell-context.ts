// Sprint 046 — Studio design overhaul (plan T006 + contracts/ui-contracts.md).
//
// `StudioShellContext` exposes layout + preview-input + reference-picker
// state to every descendant of the new `StudioShell`. The shell owns
// the state; children consume it via `useStudioShell()`. This keeps the
// composer's `Test` chip (rendered inside `StudioChat`, which is a
// `children` slot of the shell) able to drive the Preview tab on the
// right without prop-drilling through studio-chat.tsx.

'use client'

import { createContext, useContext } from 'react'
import type { TestPipelineResultData } from '@/lib/build-api'

export type RightPanelTab = 'plan' | 'preview' | 'tests' | 'ledger'

export interface PreviewInputState {
  text: string
  isSending: boolean
  lastResult: TestPipelineResultData | null
  lastError: string | null
}

export interface StudioShellContextValue {
  // Layout
  activeRightTab: RightPanelTab
  setActiveRightTab: (t: RightPanelTab) => void
  rightCollapsed: boolean
  setRightCollapsed: (v: boolean) => void
  leftCollapsed: boolean
  setLeftCollapsed: (v: boolean) => void

  // Preview input + Test-chip bridge (FR-025b + FR-033)
  previewInput: PreviewInputState
  setPreviewInputText: (t: string) => void
  runPreview: (text: string) => void

  // Reference picker (FR-025a) — composer chip → shell opens popover
  openReferencePicker: (anchorEl: HTMLElement) => void
  closeReferencePicker: () => void
}

export const StudioShellContext = createContext<StudioShellContextValue | null>(null)

const NO_OP_CONTEXT: StudioShellContextValue = {
  activeRightTab: 'plan',
  setActiveRightTab: () => {},
  rightCollapsed: false,
  setRightCollapsed: () => {},
  leftCollapsed: false,
  setLeftCollapsed: () => {},
  previewInput: {
    text: '',
    isSending: false,
    lastResult: null,
    lastError: null,
  },
  setPreviewInputText: () => {},
  runPreview: () => {},
  openReferencePicker: () => {},
  closeReferencePicker: () => {},
}

/**
 * Returns the StudioShell context, or a no-op default when rendered
 * outside the shell (e.g. in a unit test that mounts StudioChat
 * directly). The no-op default keeps descendants safe to render; real
 * interactions (opening the reference picker, running a preview) are
 * simply ignored until the shell is mounted around them.
 */
export function useStudioShell(): StudioShellContextValue {
  return useContext(StudioShellContext) ?? NO_OP_CONTEXT
}
