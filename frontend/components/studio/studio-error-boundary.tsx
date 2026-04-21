'use client'

/**
 * Sprint 058-A F9a — Error boundary around <StudioChat/>.
 *
 * The 057-A ship introduced React minified #310 (hook-order) crashes in
 * long tool-loop turns. This boundary ensures the entire Studio surface
 * never blanks out on a render error inside the chat view — the operator
 * sees a recoverable card with a "Copy diagnostic" affordance.
 *
 * The boundary tracks the last few SSE part types it saw via a static
 * `recordPart` helper so the diagnostic captures recent stream activity.
 * The record is process-wide (not instance-scoped) because the error
 * handler fires after the failing render tore down its state.
 *
 * Graceful-degradation spec §1: the boundary itself is the safety net,
 * and is styled to match the Studio palette so the recovery card reads
 * as product, not stack trace.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { STUDIO_COLORS } from './tokens'

const MAX_RECENT_PARTS = 3
const recentPartTypes: string[] = []

/** Called by StudioChat whenever it processes a SSE part so the boundary
 *  can include the last 3 part types in its diagnostic copy. */
export function recordStudioStreamPart(type: string): void {
  if (!type) return
  recentPartTypes.push(type)
  if (recentPartTypes.length > MAX_RECENT_PARTS) {
    recentPartTypes.shift()
  }
}

export function __resetStudioErrorBoundaryRecorderForTest(): void {
  recentPartTypes.length = 0
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

interface Props {
  children: ReactNode
  /** Optional override for the "Reload" action — used by tests. */
  onReload?: () => void
  /** Optional override for clipboard write — used by tests. */
  onCopy?: (text: string) => void
}

export class StudioErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the info around so the copy-diagnostic button has the stack.
    this.setState({ info })
    // Also log to the console so dev builds show the real React message.
    // eslint-disable-next-line no-console
    console.error('[StudioErrorBoundary] caught', error, info)
  }

  private handleReload = (): void => {
    if (this.props.onReload) {
      this.props.onReload()
      return
    }
    if (typeof window !== 'undefined') {
      window.location.reload()
    }
  }

  private buildDiagnostic(): string {
    const { error, info } = this.state
    const lines = [
      `Studio error: ${error?.name ?? 'Error'}: ${error?.message ?? '(no message)'}`,
      '',
      'Recent SSE part types (newest last):',
      recentPartTypes.length > 0 ? recentPartTypes.join(' → ') : '(none recorded)',
      '',
      'Component stack:',
      info?.componentStack ?? '(no componentStack)',
      '',
      'Error stack:',
      error?.stack ?? '(no stack)',
    ]
    return lines.join('\n')
  }

  private handleCopy = (): void => {
    const text = this.buildDiagnostic()
    if (this.props.onCopy) {
      this.props.onCopy(text)
      return
    }
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      // Fire-and-forget; if it rejects, the operator still has the console.
      navigator.clipboard.writeText(text).catch(() => {
        /* ignore */
      })
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const { error } = this.state
    return (
      <div
        role="alert"
        className="flex h-full min-h-0 flex-1 items-center justify-center p-6"
        style={{ background: STUDIO_COLORS.canvas }}
        data-testid="studio-error-boundary"
      >
        <div
          className="max-w-md rounded-md border px-4 py-4"
          style={{
            borderColor: STUDIO_COLORS.hairline,
            background: STUDIO_COLORS.surfaceRaised,
          }}
        >
          <div
            className="mb-1 text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: STUDIO_COLORS.dangerFg }}
          >
            Something broke in the chat view
          </div>
          <p
            className="mt-1 text-[12px] leading-[1.55]"
            style={{ color: STUDIO_COLORS.inkMuted, margin: 0 }}
          >
            The Studio chat view hit a rendering error and was caught
            before it crashed the page. Reload to recover — your artifacts
            and session history are safe.
          </p>
          <p
            className="mt-2 font-mono text-[11px]"
            style={{ color: STUDIO_COLORS.inkSubtle, margin: 0 }}
          >
            {error.name}: {error.message || '(no message)'}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              data-testid="studio-error-reload"
              className="rounded border px-2 py-1 text-[12px] font-medium"
              style={{
                borderColor: STUDIO_COLORS.hairline,
                background: STUDIO_COLORS.ink,
                color: '#FFFFFF',
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.handleCopy}
              data-testid="studio-error-copy"
              className="rounded border px-2 py-1 text-[12px] font-medium"
              style={{
                borderColor: STUDIO_COLORS.hairline,
                background: STUDIO_COLORS.surfaceRaised,
                color: STUDIO_COLORS.ink,
              }}
            >
              Copy diagnostic
            </button>
          </div>
        </div>
      </div>
    )
  }
}
