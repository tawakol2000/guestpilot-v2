'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronLeft, Menu } from 'lucide-react'
import { TUNING_COLORS } from './tokens'

const links: Array<{ href: string; label: string; group?: 'review' | 'configure' | 'analyze' }> = [
  { href: '/tuning', label: 'Suggestions', group: 'review' },
  { href: '/tuning/agent', label: 'Agent', group: 'configure' },
  { href: '/tuning/playground', label: 'Playground', group: 'configure' },
  { href: '/tuning/sessions', label: 'Sessions', group: 'review' },
  { href: '/tuning/history', label: 'History', group: 'analyze' },
  { href: '/tuning/pairs', label: 'Pairs', group: 'analyze' },
  { href: '/tuning/capability-requests', label: 'Capability requests', group: 'analyze' },
]

export function TuningTopNav({ onOpenDrawer }: { onOpenDrawer?: () => void } = {}) {
  const pathname = usePathname()
  return (
    <header
      className="sticky top-0 z-30 border-b backdrop-blur"
      style={{
        borderColor: TUNING_COLORS.hairline,
        background: 'rgba(249, 250, 251, 0.8)',
      }}
    >
      {/* Compact top-nav: h-14 → h-11 (56px → 44px). Tighter gaps.
          Active underline repositioned from -bottom-[15px] to
          -bottom-[11px] to match the new header edge. */}
      <div className="mx-auto flex h-11 items-center gap-3 px-3 md:gap-6 md:px-6">
        {onOpenDrawer ? (
          <button
            type="button"
            onClick={onOpenDrawer}
            aria-label="Open queue"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] transition-colors duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] md:hidden"
          >
            <Menu size={16} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}

        <Link
          href="/"
          className="group flex items-center gap-1 text-[13px] text-[#6B7280] transition-colors duration-200 hover:text-[#1A1A1A]"
        >
          <ChevronLeft
            size={14}
            strokeWidth={1.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
            aria-hidden
          />
          <span>Inbox</span>
        </Link>

        <div
          aria-hidden
          className="hidden h-4 w-px md:block"
          style={{ background: TUNING_COLORS.hairline }}
        />

        <nav
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Tuning sections"
        >
          {links.map((l) => {
            const active =
              pathname === l.href || (l.href !== '/tuning' && pathname.startsWith(l.href))
            return (
              <Link
                key={l.href}
                href={l.href}
                className={
                  'relative px-2.5 py-1 text-[13px] transition-colors duration-200 ' +
                  (active
                    ? 'font-semibold text-[#1A1A1A]'
                    : 'font-medium text-[#6B7280] hover:text-[#1A1A1A]')
                }
              >
                {l.label}
                {active ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -bottom-[11px] left-2.5 right-2.5 h-[2px] rounded-full"
                    style={{ background: TUNING_COLORS.accent }}
                  />
                ) : null}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
