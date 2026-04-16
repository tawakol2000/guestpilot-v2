'use client'

/**
 * Feature 041 sprint 07 — keyboard shortcuts help.
 *
 * Press `?` anywhere in /tuning to open a small modal documenting the
 * keyboard shortcuts. A trigger button floats bottom-right as a
 * discoverable affordance. The modal respects Escape, click-outside,
 * and prefers-reduced-motion.
 */

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Keyboard, X } from 'lucide-react'
import { TUNING_COLORS } from './tokens'

type Shortcut = {
  keys: string[]
  label: string
  hint?: string
}

type ShortcutGroup = { heading: string; items: Shortcut[] }

const QUEUE_GROUP: ShortcutGroup = {
  heading: 'Queue',
  items: [
    { keys: ['J'], label: 'Next suggestion' },
    { keys: ['K'], label: 'Previous suggestion' },
    { keys: ['Enter'], label: 'Focus detail' },
  ],
}

const GLOBAL_GROUP: ShortcutGroup = {
  heading: 'Global',
  items: [
    { keys: ['?'], label: 'Keyboard shortcuts' },
    { keys: ['Esc'], label: 'Close panel / modal' },
  ],
}

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Bug fix — j/k/Enter only work on the main /tuning (queue) page;
  // advertising them on /tuning/agent, /tuning/playground, etc. misleads
  // users into pressing keys that do nothing. Scope the list per route.
  const shortcuts = useMemo<ShortcutGroup[]>(() => {
    const onQueue = pathname === '/tuning'
    return onQueue ? [QUEUE_GROUP, GLOBAL_GROUP] : [GLOBAL_GROUP]
  }, [pathname])

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null
      const isInInput =
        !!target && (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable)
      if (!open) {
        if (ev.key === '?' && !isInInput) {
          ev.preventDefault()
          setOpen(true)
        }
        return
      }
      if (ev.key === 'Escape') {
        ev.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Show keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        className="group fixed bottom-5 right-5 z-40 hidden h-9 w-9 items-center justify-center rounded-full border bg-white text-[#6B7280] shadow-sm transition-all duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2 md:inline-flex"
        style={{ borderColor: TUNING_COLORS.hairline }}
      >
        <Keyboard size={14} strokeWidth={2} aria-hidden />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            className="w-[min(440px,92vw)] rounded-xl bg-white shadow-2xl animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <header
              className="flex items-start justify-between border-b px-5 py-4"
              style={{ borderColor: TUNING_COLORS.hairline }}
            >
              <div>
                <div className="text-xs font-medium text-[#6B7280]">Help</div>
                <div className="mt-0.5 text-lg font-semibold tracking-tight text-[#1A1A1A]">
                  Keyboard shortcuts
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6B7280] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
              >
                <X size={16} strokeWidth={2} aria-hidden />
              </button>
            </header>
            <div className="px-5 py-4">
              {shortcuts.map((group) => (
                <section
                  key={group.heading}
                  className="mb-4 last:mb-0"
                >
                  <h3 className="mb-2 text-xs font-semibold text-[#6B7280]">
                    {group.heading}
                  </h3>
                  <ul className="space-y-1.5">
                    {group.items.map((s) => (
                      <li
                        key={s.label}
                        className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm transition-colors duration-150 hover:bg-[#F9FAFB]"
                      >
                        <span className="text-[#1A1A1A]">{s.label}</span>
                        <span className="flex items-center gap-1">
                          {s.keys.map((k) => (
                            <kbd
                              key={k}
                              className="inline-flex min-w-[22px] items-center justify-center rounded-md border bg-white px-1.5 font-mono text-xs font-medium text-[#1A1A1A] shadow-[inset_0_-1px_0_rgba(0,0,0,0.04)]"
                              style={{ borderColor: TUNING_COLORS.hairline, height: 22 }}
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
