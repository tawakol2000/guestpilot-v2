// Sprint 046 — Studio design overhaul (plan T009).
//
// Lucide-inspired 1.6-stroke icons at 16px default, per the design
// handoff spec (README.md "Assets — Custom 24×24 lucide-inspired
// stroke icons (1.6 weight)"). Every icon takes `size` (default 16)
// and `className` (forwarded to the root <svg>). Stroke color resolves
// to `currentColor` so callers can recolor via text-color utilities.
//
// Only the icons referenced by the new shell (left rail + top bar +
// right-panel tabs + composer + drawer + empty states) are defined
// here. When a new glyph is needed, add it below alphabetically.

import type { SVGProps } from 'react'

export interface StudioIconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number
}

function base(size: number, props: StudioIconProps) {
  const { className, ...rest } = props
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': props['aria-label'] ? undefined : true,
    ...rest,
  }
}

/** 4-line asterisk-style glyph used as the Studio brand mark. Blue fill
 *  when placed on the brand-row square; `currentColor` stroke otherwise. */
export function BrandAsteriskIcon({ size = 18, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M12 4v16" />
      <path d="M4 12h16" />
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  )
}

export function PlusIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export function SearchIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  )
}

export function SendIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 12, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 12, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function ChevronLeftIcon({ size = 12, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  )
}

export function SparkleIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M12 4v4" />
      <path d="M12 16v4" />
      <path d="M4 12h4" />
      <path d="M16 12h4" />
      <path d="M7 7l2.5 2.5" />
      <path d="M14.5 14.5L17 17" />
      <path d="M17 7l-2.5 2.5" />
      <path d="M9.5 14.5L7 17" />
    </svg>
  )
}

export function CheckIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M5 12l5 5 9-11" />
    </svg>
  )
}

export function CircleIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

export function ArrowUpIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  )
}

export function PaperclipIcon({ size = 14, ...p }: StudioIconProps) {
  // Kept in the icon set even though the composer's paperclip chip is
  // out of scope (spec Clarifications Q2). Some existing drawers still
  // render it; unused imports are fine — tree-shaken at build.
  return (
    <svg {...base(size, p)}>
      <path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7l9-9a3.5 3.5 0 115 5l-9 9a2 2 0 11-3-3l8-8" />
    </svg>
  )
}

export function FileIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

export function FlaskIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M10 3v5l-5 10a2 2 0 002 3h10a2 2 0 002-3l-5-10V3" />
      <path d="M9 3h6" />
    </svg>
  )
}

export function PlayIcon({ size = 12, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M8 5v14l11-7-11-7z" />
    </svg>
  )
}

export function PanelRightIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  )
}

export function PanelLeftIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

export function BookIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M4 4a2 2 0 012-2h12v16H6a2 2 0 00-2 2V4z" />
      <path d="M4 4v16a2 2 0 002 2h12" />
    </svg>
  )
}

export function HotelIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="4" y="6" width="16" height="14" rx="1" />
      <path d="M4 10h16" />
      <path d="M9 14h.01" />
      <path d="M14 14h.01" />
      <path d="M9 18h.01" />
      <path d="M14 18h.01" />
    </svg>
  )
}

export function ExternalIcon({ size = 12, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />
    </svg>
  )
}

export function CloseIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M6 6l12 12" />
      <path d="M6 18L18 6" />
    </svg>
  )
}

export function DiffIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M12 3v18" />
      <path d="M5 8l4-4 4 4" />
      <path d="M11 16l4 4 4-4" />
    </svg>
  )
}

export function CopyIcon({ size = 14, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
    </svg>
  )
}

export function MenuIcon({ size = 16, ...p }: StudioIconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </svg>
  )
}

export function MessageSquareIcon({ size = 32, ...p }: StudioIconProps) {
  // Used in the empty-state illustration (48px blue-soft square).
  return (
    <svg {...base(size, p)}>
      <path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H9l-5 4V5z" />
    </svg>
  )
}
