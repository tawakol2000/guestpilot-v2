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
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#FAFAF9]">
        <span className="text-sm text-[#A8A29E]">Loading…</span>
      </div>
    )
  }
  return <>{children}</>
}
