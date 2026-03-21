'use client'

import React from 'react'

interface ErrorBoundaryProps {
  children: React.ReactNode
  /** Optional fallback UI — defaults to a "Something went wrong" card with Reload button */
  fallback?: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Generic React error boundary.
 * Catches render errors in children and displays a recoverable fallback UI
 * instead of killing the entire dashboard.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack)
  }

  handleReload = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            padding: 40,
            fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: '#FEE2E2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
            }}
          >
            !
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0A0A0A' }}>
            Something went wrong
          </div>
          <div
            style={{
              fontSize: 12,
              color: '#666666',
              maxWidth: 320,
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            An unexpected error occurred in this section. Your other tabs are unaffected.
          </div>
          {this.state.error && (
            <pre
              style={{
                fontSize: 10,
                color: '#999',
                background: '#F5F5F4',
                padding: '8px 12px',
                borderRadius: 6,
                maxWidth: 400,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            style={{
              marginTop: 4,
              height: 34,
              padding: '0 20px',
              fontSize: 13,
              fontWeight: 600,
              background: '#0A0A0A',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Reload section
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
