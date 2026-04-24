// Sprint 046 — Studio design overhaul
//
// Inter Tight + JetBrains Mono for the /studio surface (plan T002 +
// research.md R1). Loaded via `next/font/google` so the font files are
// self-hosted at build time — zero runtime network fetch, zero layout
// shift (display: 'swap' + system-sans / system-mono fallback).
//
// Studio chrome consumes these via the CSS variables `--font-inter-tight`
// and `--font-jetbrains-mono`. Tailwind's `font-sans` / `font-mono`
// utilities resolve to the Studio variables inside `[data-studio-shell]`
// (see globals.css T004 wiring). Outside Studio the rest of the app
// continues to use its existing Plus Jakarta Sans / Playfair Display
// stack defined in layout.tsx.

import { Inter_Tight, JetBrains_Mono } from 'next/font/google'

export const fontInterTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-inter-tight',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
})

export const fontJetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  weight: ['400', '500'],
  display: 'swap',
})
