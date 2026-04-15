import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tuning — GuestPilot',
}

export default function TuningLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-[#FAFAF9] text-[#0C0A09]">{children}</div>
}
