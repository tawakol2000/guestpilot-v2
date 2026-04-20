'use client'

/**
 * Sprint 046 Session C — /tuning/agent is now a 302 redirect to the
 * Studio tab (plan §3 + §6.5). The advanced raw-prompt editor is
 * deferred to sprint 047 as an admin-only drawer inside Studio. For now
 * managers arriving on /tuning/agent land on the conversational Studio
 * surface — which is the primary editing path for sprint 046+.
 */
import { Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'

function TuningAgentRedirectInner() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/?tab=studio')
  }, [router])
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui', color: '#666' }}>
      Redirecting to Studio…
    </div>
  )
}

export default function TuningAgentRedirect() {
  return (
    <Suspense fallback={null}>
      <TuningAgentRedirectInner />
    </Suspense>
  )
}
