'use client'

/**
 * Sprint 052 A C1 — markdown-rendered body for SOP / FAQ / system_prompt
 * viewers.
 *
 * Replaces the monospace `<pre>` that shipped in 051-A-B1 with a real
 * markdown render so operators see headings, lists, bold, code blocks,
 * and GFM tables the way they were authored. Diff mode (toggle ON) still
 * renders raw text through `diff-body.tsx` — markdown-AST diff is a much
 * bigger lift than is worth this sprint, and "view changes" is a debug
 * affordance, not the primary read path.
 *
 * Heading-anchor scroll — every h1/h2/h3 gets a `data-section` attribute
 * set to the shared slug rule (`frontend/lib/slug.ts`). When
 * `scrollToSectionSlug` is set, the component scrolls the matching
 * heading into view after one rAF so the markdown has painted. Stale
 * fragments degrade to a silent no-op — no crash, no console noise.
 *
 * Pending grammar (A1 origin invariant): when `isPending` is true, the
 * whole body wraps in an italic grey tone. Reader can't tell the grammar
 * comes from a wrapper div vs a <pre>, and they shouldn't.
 */
import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { slug as slugify } from '@/lib/slug'
import { STUDIO_COLORS } from '../tokens'

export interface MarkdownBodyProps {
  body: string
  isPending: boolean
  scrollToSectionSlug?: string | null
}

export function MarkdownBody({
  body,
  isPending,
  scrollToSectionSlug,
}: MarkdownBodyProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!scrollToSectionSlug) return
    const root = rootRef.current
    if (!root) return
    const frame = requestAnimationFrame(() => {
      const target = Array.from(
        root.querySelectorAll<HTMLElement>('[data-section]'),
      ).find((el) => el.dataset.section === scrollToSectionSlug)
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [scrollToSectionSlug, body])

  return (
    <div
      ref={rootRef}
      data-origin={isPending ? 'pending' : 'agent'}
      style={{
        fontSize: 13,
        lineHeight: 1.55,
        color: isPending ? STUDIO_COLORS.inkMuted : STUDIO_COLORS.ink,
        fontStyle: isPending ? 'italic' : 'normal',
        padding: 12,
        background: STUDIO_COLORS.surfaceSunken,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 5,
        wordBreak: 'break-word',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <Heading level={1} {...props} />,
          h2: (props) => <Heading level={2} {...props} />,
          h3: (props) => <Heading level={3} {...props} />,
          p: ({ children }) => (
            <p style={{ margin: '0 0 10px 0' }}>{children}</p>
          ),
          ul: ({ children }) => (
            <ul style={{ margin: '0 0 10px 18px', padding: 0 }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: '0 0 10px 18px', padding: 0 }}>{children}</ol>
          ),
          li: ({ children }) => (
            <li style={{ margin: '2px 0' }}>{children}</li>
          ),
          code: (props: React.HTMLAttributes<HTMLElement>) => {
            const { children, className, ...rest } = props
            const isBlock = typeof className === 'string' && /language-/.test(className)
            if (isBlock) {
              return (
                <code
                  className={className}
                  style={{
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    fontSize: 12,
                  }}
                  {...rest}
                >
                  {children}
                </code>
              )
            }
            return (
              <code
                style={{
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 12,
                  padding: '0 4px',
                  background: STUDIO_COLORS.surfaceRaised,
                  border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                  borderRadius: 3,
                }}
                {...rest}
              >
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre
              style={{
                margin: '0 0 10px 0',
                padding: 10,
                background: STUDIO_COLORS.canvas,
                border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                borderRadius: 4,
                fontSize: 12,
                lineHeight: 1.5,
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <table
              style={{
                borderCollapse: 'collapse',
                fontSize: 12,
                margin: '0 0 10px 0',
                width: '100%',
              }}
            >
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th
              style={{
                textAlign: 'left',
                padding: '4px 8px',
                borderBottom: `1px solid ${STUDIO_COLORS.hairline}`,
                fontWeight: 600,
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                padding: '4px 8px',
                borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
              }}
            >
              {children}
            </td>
          ),
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '0 0 10px 0',
                padding: '4px 12px',
                borderLeft: `2px solid ${STUDIO_COLORS.hairline}`,
                color: STUDIO_COLORS.inkMuted,
              }}
            >
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              style={{ color: STUDIO_COLORS.accent, textDecoration: 'none' }}
            >
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}

function Heading({
  level,
  children,
}: {
  level: 1 | 2 | 3
  children?: React.ReactNode
}) {
  const text = extractText(children)
  const id = slugify(text)
  const fontSize = level === 1 ? 16 : level === 2 ? 14 : 13
  const marginTop = level === 1 ? 0 : level === 2 ? 12 : 8
  const Tag = (`h${level}` as unknown) as 'h1'
  return (
    <Tag
      id={id || undefined}
      data-section={id || undefined}
      style={{
        margin: `${marginTop}px 0 6px 0`,
        fontSize,
        fontWeight: 600,
        color: STUDIO_COLORS.ink,
        scrollMarginTop: 12,
      }}
    >
      {children}
    </Tag>
  )
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}
