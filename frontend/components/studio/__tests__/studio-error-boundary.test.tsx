/**
 * Sprint 058-A F9a — StudioErrorBoundary tests.
 *
 * The boundary is a graceful-degradation safety net around <StudioChat/>.
 * These tests cover:
 *   - children render normally when there's no error
 *   - a throwing child produces the recovery card with reload + copy
 *   - the diagnostic text includes the error message and recorded SSE
 *     part types
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Component, type ReactNode } from 'react'

import {
  StudioErrorBoundary,
  recordStudioStreamPart,
  __resetStudioErrorBoundaryRecorderForTest,
} from '../studio-error-boundary'

// Silence the expected React error log that componentDidCatch triggers.
const originalConsoleError = console.error
beforeEach(() => {
  __resetStudioErrorBoundaryRecorderForTest()
  console.error = vi.fn()
})
afterAll(() => {
  console.error = originalConsoleError
})

function Thrower({ message }: { message: string }): ReactNode {
  throw new Error(message)
}

class ResetOnRenderKey extends Component<
  { renderKey: number; children: ReactNode },
  { childKey: number }
> {
  state = { childKey: this.props.renderKey }
  render(): ReactNode {
    return this.props.children
  }
}

describe('StudioErrorBoundary (058-A F9a)', () => {
  it('renders children when no error', () => {
    render(
      <StudioErrorBoundary>
        <div data-testid="healthy">All good</div>
      </StudioErrorBoundary>,
    )
    expect(screen.getByTestId('healthy')).toBeInTheDocument()
  })

  it('renders the recovery card when a child throws', () => {
    render(
      <StudioErrorBoundary onReload={() => {}}>
        <Thrower message="boom in render" />
      </StudioErrorBoundary>,
    )
    expect(screen.getByTestId('studio-error-boundary')).toBeInTheDocument()
    expect(screen.getByTestId('studio-error-reload')).toBeInTheDocument()
    expect(screen.getByTestId('studio-error-copy')).toBeInTheDocument()
    expect(screen.getByText(/boom in render/)).toBeInTheDocument()
  })

  it('copies a diagnostic that includes recorded SSE part types', () => {
    recordStudioStreamPart('data-build-plan')
    recordStudioStreamPart('tool-create_sop')
    recordStudioStreamPart('step-start')

    const onCopy = vi.fn()
    render(
      <StudioErrorBoundary onReload={() => {}} onCopy={onCopy}>
        <Thrower message="kaboom" />
      </StudioErrorBoundary>,
    )

    fireEvent.click(screen.getByTestId('studio-error-copy'))
    expect(onCopy).toHaveBeenCalledTimes(1)
    const text = onCopy.mock.calls[0][0] as string
    expect(text).toMatch(/kaboom/)
    expect(text).toMatch(/data-build-plan/)
    expect(text).toMatch(/tool-create_sop/)
    expect(text).toMatch(/step-start/)
  })

  it('reload handler fires when the operator clicks Reload', () => {
    const onReload = vi.fn()
    render(
      <StudioErrorBoundary onReload={onReload}>
        <Thrower message="x" />
      </StudioErrorBoundary>,
    )
    fireEvent.click(screen.getByTestId('studio-error-reload'))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('keeps only the last 3 SSE part types in the recorder', () => {
    recordStudioStreamPart('a')
    recordStudioStreamPart('b')
    recordStudioStreamPart('c')
    recordStudioStreamPart('d')
    const onCopy = vi.fn()
    render(
      <StudioErrorBoundary onReload={() => {}} onCopy={onCopy}>
        <Thrower message="z" />
      </StudioErrorBoundary>,
    )
    fireEvent.click(screen.getByTestId('studio-error-copy'))
    const text = onCopy.mock.calls[0][0] as string
    expect(text).not.toMatch(/(^|[^a-z])a([^a-z]|$)/)
    expect(text).toMatch(/b → c → d/)
  })
})
