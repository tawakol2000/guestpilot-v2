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
      <div className="mx-auto flex h-14 items-center gap-4 px-4 md:gap-8 md:px-8">
        {onOpenDrawer ? (
          <button
            type="button"
            onClick={onOpenDrawer}
            aria-label="Open queue"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#6B7280] transition-colors duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] md:hidden"
          >
            <Menu size={18} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}

        <Link
          href="/"
          className="group flex items-center gap-1.5 text-sm text-[#6B7280] transition-colors duration-200 hover:text-[#1A1A1A]"
        >
          <ChevronLeft
            size={16}
            strokeWidth={1.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
            aria-hidden
          />
          <span>Inbox</span>
        </Link>

        <div
          aria-hidden
          className="hidden h-5 w-px md:block"
          style={{ background: TUNING_COLORS.hairline }}
        />

        <nav
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                  'relative px-3 py-1.5 text-sm transition-colors duration-200 ' +
                  (active
                    ? 'font-semibold text-[#1A1A1A]'
                    : 'font-medium text-[#6B7280] hover:text-[#1A1A1A]')
                }
              >
                {l.label}
                {active ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -bottom-[15px] left-3 right-3 h-[2px] rounded-full"
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
