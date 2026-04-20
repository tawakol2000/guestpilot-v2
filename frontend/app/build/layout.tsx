import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Build · GuestPilot',
  description: 'Build your AI agent — SOPs, FAQs, tools, system prompt.',
}

export default function BuildLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
