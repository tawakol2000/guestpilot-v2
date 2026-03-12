'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { isAuthenticated } from '@/lib/api'
import InboxV5 from '@/components/inbox-v5'

function AuthPage() {
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
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FFFFFF',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: '#0A0A0A',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: '#FFFFFF',
                fontFamily: 'system-ui, -apple-system, sans-serif',
              }}
            >
              GP
            </span>
          </div>
          <p
            style={{
              fontSize: 13,
              color: '#999999',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              margin: 0,
            }}
          >
            Loading…
          </p>
        </div>
      </div>
    )
  }

  return <InboxV5 />
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#FFFFFF',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: '#0A0A0A',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: '#FFFFFF',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
              >
                GP
              </span>
            </div>
          </div>
        </div>
      }
    >
      <AuthPage />
    </Suspense>
  )
}
