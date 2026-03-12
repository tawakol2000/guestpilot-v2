'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { apiLogin, apiSignup, setToken, setTenantMeta, isAuthenticated } from '@/lib/api'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [hostawayApiKey, setHostawayApiKey] = useState('')
  const [hostawayAccountId, setHostawayAccountId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isAuthenticated()) router.replace('/')
  }, [router])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = mode === 'login'
        ? await apiLogin(email, password)
        : await apiSignup(email, password, hostawayApiKey, hostawayAccountId)

      setToken(res.token)
      setTenantMeta({ email: res.email, plan: res.plan, tenantId: res.tenantId, webhookUrl: res.webhookUrl })
      router.replace('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: '#F2EDE8' }}
    >
      <div className="w-full max-w-md px-4">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2.5 mb-2">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg font-bold"
              style={{ background: 'var(--terracotta, #D97B4F)' }}
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
          <p className="text-sm" style={{ color: '#8E8E93' }}>
            {mode === 'login' ? 'Sign in to your account' : 'Create your account'}
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-8"
          style={{
            background: '#fff',
            boxShadow: '0 2px 24px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)',
          }}
        >
          {/* Mode tabs */}
          <div
            className="flex rounded-xl p-1 mb-6 gap-1"
            style={{ background: '#F2F2F7' }}
          >
            {(['login', 'signup'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); setError('') }}
                className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                style={
                  mode === m
                    ? { background: '#fff', color: '#1A1109', boxShadow: '0 1px 4px rgba(0,0,0,0.1)' }
                    : { color: '#8E8E93' }
                }
              >
                {m === 'login' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold" style={{ color: '#1A1109' }}>Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none transition-all"
                style={{
                  background: '#F2F2F7',
                  border: '1.5px solid transparent',
                  color: '#1A1109',
                }}
                onFocus={e => (e.target.style.borderColor = '#D97B4F')}
                onBlur={e => (e.target.style.borderColor = 'transparent')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold" style={{ color: '#1A1109' }}>Password</label>
              <input
                type="password"
                required
                minLength={mode === 'signup' ? 8 : 1}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'Min 8 characters' : '••••••••'}
                className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none transition-all"
                style={{
                  background: '#F2F2F7',
                  border: '1.5px solid transparent',
                  color: '#1A1109',
                }}
                onFocus={e => (e.target.style.borderColor = '#D97B4F')}
                onBlur={e => (e.target.style.borderColor = 'transparent')}
              />
            </div>

            {mode === 'signup' && (
              <>
                <div
                  className="rounded-xl px-4 py-3 text-xs"
                  style={{ background: '#FFF7ED', border: '1px solid #FDE68A', color: '#92400E' }}
                >
                  You&apos;ll need your Hostaway API credentials. Find them in Hostaway → Settings → API.
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold" style={{ color: '#1A1109' }}>Hostaway Account ID</label>
                  <input
                    type="text"
                    required
                    value={hostawayAccountId}
                    onChange={e => setHostawayAccountId(e.target.value)}
                    placeholder="e.g. 12345"
                    className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{
                      background: '#F2F2F7',
                      border: '1.5px solid transparent',
                      color: '#1A1109',
                    }}
                    onFocus={e => (e.target.style.borderColor = '#D97B4F')}
                    onBlur={e => (e.target.style.borderColor = 'transparent')}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold" style={{ color: '#1A1109' }}>Hostaway API Key</label>
                  <input
                    type="password"
                    required
                    value={hostawayApiKey}
                    onChange={e => setHostawayApiKey(e.target.value)}
                    placeholder="Your Hostaway API key"
                    className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{
                      background: '#F2F2F7',
                      border: '1.5px solid transparent',
                      color: '#1A1109',
                    }}
                    onFocus={e => (e.target.style.borderColor = '#D97B4F')}
                    onBlur={e => (e.target.style.borderColor = 'transparent')}
                  />
                </div>
              </>
            )}

            {error && (
              <div
                className="rounded-xl px-4 py-3 text-xs font-medium"
                style={{ background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA' }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-opacity mt-1"
              style={{ background: '#D97B4F', opacity: loading ? 0.6 : 1 }}
            >
              {loading
                ? 'Please wait...'
                : mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs mt-6" style={{ color: '#8E8E93' }}>
          GuestPilot © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
