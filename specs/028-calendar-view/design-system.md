# Design System: GuestPilot Calendar View

**Generated**: 2026-04-02
**Source**: UI/UX Pro Max skill analysis

> Reference this file during implementation. Apply these tokens and rules when building the component.

## Color Palette

### Base (Calendar & Scheduling)

| Role | Hex | Usage |
|------|-----|-------|
| Primary | `#2563EB` | Today marker, active states, primary buttons |
| Secondary | `#3B82F6` | Selected date range, hover highlights |
| Accent (Available) | `#059669` | Available indicator, success states |
| Background | `#F8FAFC` | Page background |
| Foreground | `#0F172A` | Primary text |
| Card | `#FFFFFF` | Property sidebar, tooltip cards |
| Muted | `#F1F5FD` | Weekend column tint, empty cells |
| Muted Foreground | `#64748B` | Nightly prices, secondary labels |
| Border | `#E4ECFC` | Grid lines, cell borders |
| Destructive | `#DC2626` | Cancelled state (if shown) |

### Channel Colors (Pastel — Reservation Bars)

| Channel | Bar Background | Bar Text | Border Left |
|---------|---------------|----------|-------------|
| Airbnb | `#FEE2E2` (rose-100) | `#991B1B` (rose-800) | `#F87171` (rose-400) |
| Booking.com | `#DBEAFE` (blue-100) | `#1E3A8A` (blue-900) | `#60A5FA` (blue-400) |
| Direct | `#D1FAE5` (emerald-100) | `#065F46` (emerald-800) | `#34D399` (emerald-400) |
| WhatsApp | `#DCFCE7` (green-100) | `#166534` (green-800) | `#4ADE80` (green-400) |
| Other | `#F1F5F9` (slate-100) | `#334155` (slate-700) | `#94A3B8` (slate-400) |

### Status Visual Patterns

| Status | Style | Description |
|--------|-------|-------------|
| CONFIRMED | Solid fill | Full pastel background, solid bar |
| INQUIRY | Dashed border | Transparent fill + 2px dashed border in channel color |
| PENDING | Striped | Diagonal stripe pattern (45deg, 4px) over lighter tint |
| CHECKED_IN | Solid + left accent | Same as CONFIRMED + 3px solid left border in darker shade |

## Typography

### Primary: Inter (existing in project via Tailwind)

Already used in the frontend — no new font import needed.

| Element | Weight | Size | Color |
|---------|--------|------|-------|
| Page title ("Calendar") | 600 (semibold) | 24px | `#0F172A` |
| Property name (sidebar) | 500 (medium) | 14px | `#0F172A` |
| Occupancy % (sidebar) | 400 (regular) | 12px | `#64748B` |
| Date header (day) | 500 (medium) | 13px | `#334155` |
| Date header (weekday) | 400 (regular) | 11px | `#94A3B8` |
| Reservation bar text | 500 (medium) | 12px | Channel text color |
| Nightly price | 400 (regular) | 11px | `#94A3B8` |
| Tooltip heading | 600 (semibold) | 14px | `#0F172A` |
| Tooltip body | 400 (regular) | 13px | `#475569` |

### Tabular Figures

Use `font-variant-numeric: tabular-nums` for all price cells to prevent layout shift.

## Spacing & Layout

| Token | Value | Usage |
|-------|-------|-------|
| Row height | 48px | Each property row |
| Sidebar width | 240px | Property names + metrics |
| Day column width (2-week) | 80px | Date cells |
| Day column width (month) | 48px | Narrower for 30-day view |
| Grid border | 1px `#E4ECFC` | Cell separators |
| Bar padding | 4px 8px | Text inside reservation bars |
| Bar border-radius | 6px | Pill-shaped rounded corners |
| Bar min-width | 32px | Single-night reservations |
| Today marker width | 2px | Vertical accent line |
| Tooltip max-width | 280px | Hover detail card |

## Animation Tokens

| Animation | Duration | Easing | Trigger |
|-----------|----------|--------|---------|
| Date navigation slide | 300ms | `ease-out` | Forward/back click |
| Bar hover elevation | 150ms | `ease-out` | Mouse enter |
| Tooltip fade-in | 150ms | `ease-out` | Hover delay 100ms |
| Tooltip fade-out | 100ms | `ease-in` | Mouse leave |
| Row highlight | 100ms | `ease-out` | Mouse enter sidebar |
| Filter results | 200ms | `ease-out` | Keypress in search |
| Skeleton shimmer | 1.5s | `linear` infinite | Loading state |

## Component Structure

```
CalendarPage
├── CalendarToolbar
│   ├── TodayButton
│   ├── NavigationArrows (< >)
│   ├── MonthYearLabel
│   ├── ViewToggle (2-week | month)
│   └── PropertySearch (filter input)
├── CalendarGrid
│   ├── DateHeader (sticky top)
│   │   ├── TodayMarker (vertical line)
│   │   └── DateCell[] (day + weekday)
│   ├── PropertySidebar (sticky left)
│   │   └── PropertyRow[]
│   │       ├── PropertyName
│   │       └── OccupancyBadge
│   └── TimelineBody (scrollable both axes)
│       └── PropertyTimeline[]
│           ├── ReservationBar[] (positioned absolutely)
│           │   ├── ChannelIcon
│           │   ├── GuestName
│           │   └── GuestCount
│           └── PriceCell[] (empty dates)
└── ReservationTooltip (portal, follows mouse)
    ├── GuestName
    ├── ChannelBadge
    ├── DateRange
    ├── NightsCount
    ├── GuestCount
    └── TotalPrice
```

## Key UX Rules (from UI/UX Pro Max)

1. **Sticky headers**: Date row sticks to top, sidebar sticks to left — intersection corner cell stays fixed
2. **Weekend tint**: Saturday + Sunday columns get `#F1F5FD` background
3. **Today line**: 2px `#2563EB` vertical line spanning full grid height
4. **No horizontal scroll on sidebar**: Only the timeline body scrolls horizontally
5. **Hover row highlight**: Hovering sidebar property name highlights the full row with `#F8FAFC` → `#F1F5FD`
6. **Bar hover**: Scale slightly (`transform: translateY(-1px)`), add `box-shadow: 0 2px 8px rgba(0,0,0,0.1)`
7. **Tooltip positioning**: Smart — flips left/right if near viewport edge, always fully visible
8. **Loading skeleton**: Mirror exact grid structure with shimmer animation
9. **Back-to-back bookings**: Checkout bar ends at 50% of cell, checkin bar starts at 50%
10. **prefers-reduced-motion**: Disable slide transitions and shimmer, use instant state changes
