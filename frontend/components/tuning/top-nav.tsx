'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links: Array<{ href: string; label: string }> = [
  { href: '/tuning', label: 'Tuning' },
  { href: '/tuning/history', label: 'History' },
  { href: '/tuning/capability-requests', label: 'Capability requests' },
]

export function TuningTopNav() {
  const pathname = usePathname()
  return (
    <header className="border-b border-[#E7E5E4] bg-[#FAFAF9]/80 backdrop-blur">
      <div className="mx-auto flex h-12 items-center gap-6 px-6">
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
