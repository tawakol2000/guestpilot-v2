'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { isAuthenticated } from '@/lib/api'

export function TuningAuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login')
    } else {
      setReady(true)
    }
  }, [router])

  if (!ready) {
    // Sprint 07 palette alignment — the main /tuning surface renders on
    // the cool-neutral canvas (#F9FAFB), so this loading flash needs to
    // match. Previously it used the pre-sprint warm-stone palette
    // (#FAFAF9 + #A8A29E), producing a subtle color flash before
    // hydration.
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#F9FAFB]">
        <span className="text-sm text-[#9CA3AF]">Loading…</span>
      </div>
    )
  }
  return <>{children}</>
}
