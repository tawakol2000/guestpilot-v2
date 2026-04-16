import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tuning — GuestPilot',
}

export default function TuningLayout({ children }: { children: React.ReactNode }) {
  // Sprint 07: cool neutral canvas replaces the warm stone editorial surface.
  return <div className="min-h-dvh bg-[#F9FAFB] text-[#1A1A1A]">{children}</div>
}
