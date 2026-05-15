import type { Metadata } from 'next'
import { KeyboardShortcuts } from '@/components/tuning/keyboard-shortcuts'
import '@/components/tuning/tuning.css'

export const metadata: Metadata = {
  title: 'Tuning — GuestPilot',
}

export default function TuningLayout({ children }: { children: React.ReactNode }) {
  // Sprint 07: cool neutral canvas replaces the warm stone editorial
  // surface. The .tuning-surface class gates reduced-motion + default
  // focus-visible rings defined in tuning.css.
  // 2026-05-15: TuningToaster removed — the root layout (app/layout.tsx)
  // now mounts a sonner Toaster globally, so the per-route Toaster was
  // double-rendering toasts on this route.
  return (
    <div className="tuning-surface min-h-dvh bg-[#F9FAFB] text-[#1A1A1A]">
      {children}
      <KeyboardShortcuts />
    </div>
  )
}
