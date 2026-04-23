'use client'

/**
 * Bugfix (2026-04-23): agent prose was rendered as a single <p>{text}</p>
 * in `AttributedText`, so **bold**, *italic*, numbered lists, and
 * headings all surfaced as literal markdown characters. The Studio
 * operator asked for a Claude-desktop-style presentation: bold titles,
 * bold step numbers, real lists.
 *
 * This component wraps react-markdown (already a dependency along with
 * remark-gfm) and locks the typographic tokens to STUDIO_COLORS so the
 * data-origin="agent" vs "user" palette from Sprint 051 A B3 stays
 * intact. Citation chips still render via the separate `AttributedText`
 * path — we only invoke `AgentProse` when the chunk has no
 * `[[cite:...]]` marker, preserving the tokenised citation flow.
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { STUDIO_COLORS } from './tokens'

interface AgentProseProps {
  text: string
  isUser: boolean
}

export function AgentProse({ text, isUser }: AgentProseProps) {
  const color = isUser ? STUDIO_COLORS.ink : STUDIO_COLORS.inkMuted
  return (
    <div
      data-origin={isUser ? 'user' : 'agent'}
      className="text-[14px] leading-[1.55]"
      style={{ color }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Paragraphs preserve the pre-2026-04-23 whitespace-pre-wrap
          // behaviour for single-line agent chatter + the zero margin
          // the existing bubble used.
          p: ({ children }) => (
            <p className="whitespace-pre-wrap" style={{ margin: '0 0 10px 0' }}>
              {children}
            </p>
          ),
          strong: ({ children }) => (
            <strong style={{ fontWeight: 600, color: STUDIO_COLORS.ink }}>
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em style={{ fontStyle: 'italic' }}>{children}</em>
          ),
          ol: ({ children }) => (
            <ol
              style={{
                margin: '6px 0 10px 0',
                paddingLeft: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {children}
            </ol>
          ),
          ul: ({ children }) => (
            <ul
              style={{
                margin: '6px 0 10px 0',
                paddingLeft: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                listStyleType: 'disc',
              }}
            >
              {children}
            </ul>
          ),
          li: ({ children }) => (
            <li style={{ paddingLeft: 2 }}>{children}</li>
          ),
          h1: ({ children }) => (
            <h1
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: STUDIO_COLORS.ink,
                margin: '10px 0 6px 0',
                lineHeight: 1.3,
              }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: STUDIO_COLORS.ink,
                margin: '10px 0 6px 0',
                lineHeight: 1.3,
              }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: STUDIO_COLORS.ink,
                margin: '10px 0 4px 0',
                lineHeight: 1.3,
              }}
            >
              {children}
            </h3>
          ),
          code: ({ children, ...props }) => {
            const isBlock = 'data-block' in props
            if (isBlock) {
              return (
                <code
                  style={{
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12.5,
                    background: STUDIO_COLORS.surfaceSunken,
                    color: STUDIO_COLORS.ink,
                    padding: '8px 10px',
                    borderRadius: 6,
                    display: 'block',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {children}
                </code>
              )
            }
            return (
              <code
                style={{
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12.5,
                  background: STUDIO_COLORS.surfaceSunken,
                  color: STUDIO_COLORS.ink,
                  padding: '1px 4px',
                  borderRadius: 3,
                }}
              >
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre
              style={{
                margin: '6px 0 10px 0',
                padding: 0,
                background: 'transparent',
                overflow: 'auto',
              }}
            >
              {children}
            </pre>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: STUDIO_COLORS.accent, textDecoration: 'underline' }}
            >
              {children}
            </a>
          ),
          hr: () => (
            <hr
              style={{
                border: 'none',
                borderTop: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                margin: '10px 0',
              }}
            />
          ),
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '6px 0',
                padding: '2px 0 2px 10px',
                borderLeft: `2px solid ${STUDIO_COLORS.hairline}`,
                color: STUDIO_COLORS.inkMuted,
              }}
            >
              {children}
            </blockquote>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
