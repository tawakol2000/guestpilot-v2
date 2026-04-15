'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links: Array<{ href: string; label: string }> = [
  { href: '/tuning', label: 'Tuning' },
  { href: '/tuning/history', label: 'History' },
  { href: '/tuning/capability-requests', label: 'Capability requests' },
]

export function TuningTopNav({ onOpenDrawer }: { onOpenDrawer?: () => void } = {}) {
  const pathname = usePathname()
  return (
    <header className="border-b border-[#E7E5E4] bg-[#FAFAF9]/80 backdrop-blur">
      <div className="mx-auto flex h-12 items-center gap-3 px-3 md:gap-6 md:px-6">
        {onOpenDrawer ? (
          <button
            type="button"
            onClick={onOpenDrawer}
            aria-label="Open queue"
            className="flex h-8 w-8 items-center justify-center rounded text-[#57534E] hover:bg-[#F5F4F2] hover:text-[#0C0A09] md:hidden"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path
                d="M2 4h12M2 8h12M2 12h12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
        <Link
          href="/"
          className="text-[11px] uppercase tracking-[0.14em] text-[#57534E] hover:text-[#0C0A09]"
        >
          ← Inbox
        </Link>
        <nav className="flex items-center gap-5">
          {links.map((l) => {
            const active =
              pathname === l.href || (l.href !== '/tuning' && pathname.startsWith(l.href))
            return (
              <Link
                key={l.href}
                href={l.href}
                className={
                  'text-sm transition-colors ' +
                  (active
                    ? 'text-[#0C0A09] font-medium'
                    : 'text-[#57534E] hover:text-[#0C0A09]')
                }
              >
                {l.label}
              </Link>
            )
          })}
        </nav>
        <div className="ml-auto font-[family-name:var(--font-playfair)] text-sm italic text-[#A8A29E]">
          Tuning
        </div>
      </div>
    </header>
  )
}
