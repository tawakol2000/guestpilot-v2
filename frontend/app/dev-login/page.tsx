'use client'

/**
 * Dev-only landing page that auto-signs you in as a seeded tenant and
 * drops you on the Studio tab for a specific conversation.
 *
 * Usage (after running `npm run seed:studio-demo` on the backend):
 *   http://localhost:3000/dev-login?tenantId=<id>&conversationId=<id>
 *
 * Backend-side, the `/auth/dev-login` endpoint returns 404 unless
 * NODE_ENV !== 'production' AND DEV_AUTH_BYPASS=1 — so this page is
 * completely inert against a real deployment.
 *
 * If neither the token endpoint nor the required query params resolve,
 * we redirect to `/login` so the page fails closed.
 */

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { setToken, setTenantMeta } from '@/lib/api'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'

export default function DevLoginPage() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState('')

  useEffect(() => {
    const tenantId = params.get('tenantId') || undefined
    const email = params.get('email') || undefined
    const conversationId = params.get('conversationId') || undefined

    if (!tenantId && !email) {
      setError('Missing tenantId or email query param.')
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${BASE_URL}/auth/dev-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantId, email }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(
            body.error ||
              `Dev-login endpoint returned ${res.status}. Make sure backend has DEV_AUTH_BYPASS=1 and NODE_ENV!=production.`,
          )
        }
        const data = await res.json()
        if (cancelled) return
        setToken(data.token)
        setTenantMeta({
          email: data.email,
          plan: data.plan,
          tenantId: data.tenantId,
          webhookUrl: data.webhookUrl,
        })
        // Hop into Studio with the specific conversation preselected.
        const target = conversationId
          ? `/?tab=studio&conversationId=${encodeURIComponent(conversationId)}`
          : '/?tab=studio'
        router.replace(target)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Dev-login failed')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [params, router])

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: '#F2EDE8' }}
    >
      <div className="w-full max-w-md px-4">
        <div
          className="rounded-2xl p-8 text-center"
          style={{
            background: '#fff',
            boxShadow: '0 2px 24px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)',
          }}
        >
          <div className="flex items-center justify-center gap-2.5 mb-4">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg font-bold"
              style={{ background: '#1D4ED8' }}
            >
              G
            </div>
            <span
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: 'var(--font-playfair, serif)', color: '#1A1109' }}
            >
              GuestPilot
            </span>
          </div>

          {error ? (
            <>
              <p className="text-sm font-semibold mb-2" style={{ color: '#DC2626' }}>
                Dev-login failed
              </p>
              <p
                className="text-xs mb-4 whitespace-pre-wrap text-left rounded-xl px-4 py-3"
                style={{ background: '#FEF2F2', color: '#7F1D1D', border: '1px solid #FECACA' }}
              >
                {error}
              </p>
              <a
                href="/login"
                className="inline-block text-xs font-semibold underline"
                style={{ color: '#1D4ED8' }}
              >
                Go to regular login →
              </a>
            </>
          ) : (
            <p className="text-sm" style={{ color: '#8E8E93' }}>
              Signing you in…
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
