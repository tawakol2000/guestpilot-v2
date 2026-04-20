import type { Metadata } from 'next'

// Sprint 046 Session D — the /build route is a 302 redirect stub
// (see page.tsx). The layout used to mount BuildToaster; Studio has
// its own toaster mounted inside StudioSurface, so this layout only
// needs to set the tab title + pass children through.
export const metadata: Metadata = {
  title: 'Build · GuestPilot',
  description: 'Redirecting to the Studio tab.',
}

export default function BuildLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
