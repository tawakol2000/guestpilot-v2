import type { Metadata } from 'next'
import { Plus_Jakarta_Sans, Playfair_Display } from 'next/font/google'
import { Toaster } from 'sonner'
import { fontInterTight, fontJetbrainsMono } from './fonts'
import './globals.css'

const plusJakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', weight: ['400', '500', '600', '700', '800'] })
const playfair = Playfair_Display({ subsets: ['latin'], variable: '--font-playfair', display: 'swap' })

export const metadata: Metadata = {
  title: 'GuestPilot — Inbox',
  description: 'AI guest communication platform for short-term rental operators',
  generator: 'v0.app',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body
        className={`${plusJakarta.variable} ${playfair.variable} ${fontInterTight.variable} ${fontJetbrainsMono.variable} font-sans antialiased`}
      >
        {children}
        {/* 2026-05-15: root-level Toaster. Styling absorbed from the
            former TuningToaster so /tuning + /studio + /inbox all share
            the same calm raised-card aesthetic on the cool neutral palette. */}
        <Toaster
          richColors
          closeButton
          position="bottom-right"
          duration={3500}
          gap={12}
          expand={false}
          visibleToasts={4}
          toastOptions={{
            style: {
              background: '#ffffff',
              color: '#0a0a0b',
              border: '1px solid #e7e8ec',
              borderRadius: 12,
              boxShadow:
                '0 10px 25px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
              fontSize: 14,
              padding: '12px 14px',
            },
          }}
        />
      </body>
    </html>
  )
}
