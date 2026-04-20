'use client'

/**
 * Sprint 046 Session C — /build is now a 302 redirect to the Studio tab
 * inside the main app shell (plan §3 + §6.4). Full shell deleted; only
 * this stub survives one sprint so email/push deep-links keep working.
 * Deletion of the stub is tracked in Sprint 046 Session D / sprint 047.
 */
import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function BuildRedirectInner() {
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

export default function BuildRedirect() {
  return (
    <Suspense fallback={null}>
      <BuildRedirectInner />
    </Suspense>
  )
}
