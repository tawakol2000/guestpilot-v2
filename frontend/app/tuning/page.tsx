'use client'

/**
 * Sprint 046 Session C — /tuning is now a 302 redirect to the Studio tab
 * inside the main app shell (plan §3 + §6.4). The full tuning queue +
 * detail panel + chat panel moved into `components/studio/studio-surface.tsx`.
 * Redirect stub survives one sprint; deletion tracked in Sprint 047.
 */
import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function TuningRedirectInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  useEffect(() => {
    const qs = new URLSearchParams()
    qs.set('tab', 'studio')
    const conversationId = searchParams.get('conversationId')
    if (conversationId) qs.set('conversationId', conversationId)
    router.replace(`/?${qs.toString()}`)
  }, [router, searchParams])
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui', color: '#666' }}>
      Redirecting to Studio…
    </div>
  )
}

export default function TuningRedirect() {
  return (
    <Suspense fallback={null}>
      <TuningRedirectInner />
    </Suspense>
  )
}
