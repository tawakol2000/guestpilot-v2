# Feature Specification: Calendar View

**Feature Branch**: `028-calendar-view`
**Created**: 2026-04-02
**Status**: Draft
**Input**: Gantt-style calendar view for property reservations — Hostaway functionality, modern minimal design

## Clarifications

### Session 2026-04-02

- Q: Should v1 include per-night pricing in empty cells (requires new backend endpoint + Hostaway calendar API integration + caching) or defer? → A: Include nightly pricing in v1 with new backend endpoint, Hostaway API calls, and caching. Additionally, store reservation payout and all money-related fields on the Reservation model so financial data is available locally.
- Q: Should the calendar allow navigating into the past? → A: Yes — up to 2 months back and 6 months forward

## User Scenarios & Testing

### User Story 1 - View All Reservations on a Timeline (Priority: P1)

A property manager opens the Calendar page and sees all their properties listed as rows on the left, with a horizontal date timeline across the top. Reservations appear as softly rounded, color-coded bars spanning from check-in to check-out. Each bar shows the guest's first name and guest count. Empty date cells show the nightly price in muted text. The manager can instantly scan which properties are booked, which are available, and what revenue looks like across the portfolio.

**Why this priority**: This is the core value of the calendar — a single visual overview of all properties and bookings. Without this, nothing else matters.

**Independent Test**: Load the Calendar page with 10+ properties and 20+ reservations. All bars render in correct positions spanning exact check-in to check-out columns. Nightly prices show in empty cells. Properties are listed alphabetically on the left.

**Acceptance Scenarios**:

1. **Given** properties with active reservations exist, **When** the manager opens the Calendar page, **Then** all properties appear as rows, all reservations appear as horizontal bars spanning their check-in to check-out dates, and today's column is highlighted
2. **Given** a property has no reservations in the visible date range, **When** the manager views the calendar, **Then** the property row shows nightly prices in each empty cell
3. **Given** a reservation spans beyond the visible date range, **When** the manager views the calendar, **Then** the bar is clipped at the edge with a visual indicator (fade or arrow) showing it continues
4. **Given** the manager loads the page, **When** the calendar renders, **Then** the view auto-scrolls to center on today's date

---

### User Story 2 - Navigate and Explore the Timeline (Priority: P1)

The manager navigates the calendar using forward/back buttons, clicks "Today" to snap back, and can switch between 2-week and month views. The date header shows the current month/year context. Scrolling is smooth and responsive. A property search/filter lets them narrow down to specific properties.

**Why this priority**: Navigation is essential — the calendar is useless if managers can't move through time and find specific properties.

**Independent Test**: Click forward/back buttons and verify dates shift correctly. Click "Today" and verify it snaps to current date. Type in the property filter and verify rows filter in real-time.

**Acceptance Scenarios**:

1. **Given** the calendar is showing the current 2-week view, **When** the manager clicks the forward arrow, **Then** the view shifts forward by 7 days with a smooth transition
2. **Given** the calendar is viewing a future month, **When** the manager clicks "Today", **Then** the view smoothly scrolls/transitions to center on today's date
3. **Given** 20 properties are displayed, **When** the manager types "Apartment 1" in the search filter, **Then** only matching properties remain visible, instantly filtered as they type
4. **Given** the manager is in 2-week view, **When** they switch to month view, **Then** the timeline expands to show 30 days with narrower day columns

---

### User Story 3 - View Reservation Details (Priority: P2)

The manager hovers over a reservation bar and sees a rich tooltip with booking details: guest full name, booking channel (with icon), check-in/check-out dates, number of nights, guest count, and total price with currency. Clicking the bar opens a detail panel or navigates to the conversation for that reservation.

**Why this priority**: The overview shows shape; details complete the picture. Managers need quick access to booking specifics without leaving the calendar.

**Independent Test**: Hover over 5 different reservation bars and verify each tooltip shows correct, complete data. Click a bar and verify it opens the correct conversation.

**Acceptance Scenarios**:

1. **Given** a reservation bar is visible, **When** the manager hovers over it, **Then** a tooltip appears within 150ms showing: guest name, channel icon + name, check-in date, check-out date, nights count, guest count, total price with currency
2. **Given** a reservation bar is visible, **When** the manager clicks it, **Then** the inbox opens filtered to that reservation's conversation
3. **Given** the tooltip is showing, **When** the manager moves the mouse away from the bar, **Then** the tooltip fades out smoothly

---

### User Story 4 - Distinguish Booking Channels and Statuses (Priority: P2)

Each reservation bar is color-coded by booking channel (Airbnb, Booking.com, Direct, WhatsApp, Other) using distinct but harmonious pastel colors. A small channel icon sits at the left edge of each bar. Reservation status (Inquiry, Pending, Confirmed, Checked-in) is indicated by the bar's visual style — confirmed bookings are solid, pending/inquiry bookings use a striped or dashed pattern, checked-in bookings have a subtle glow or accent.

**Why this priority**: Quick visual scanning of channel mix and booking status is essential for portfolio management — managers need to see the breakdown without reading text.

**Independent Test**: Create reservations across all 5 channels and 4 active statuses. Verify each has a distinct, identifiable color and visual pattern.

**Acceptance Scenarios**:

1. **Given** reservations from Airbnb, Booking.com, and Direct exist, **When** viewing the calendar, **Then** each channel has a distinct color that is identifiable at a glance
2. **Given** a reservation has INQUIRY status, **When** viewing the calendar, **Then** the bar has a dashed or striped pattern to indicate it is not yet confirmed
3. **Given** a reservation has CHECKED_IN status, **When** viewing the calendar, **Then** the bar has a visual accent (e.g., left border highlight) distinguishing it from a confirmed-but-not-yet-checked-in booking

---

### User Story 5 - Responsive Sidebar with Property Summary (Priority: P3)

The left sidebar showing property names also displays a compact summary: property name, number of active bookings this month, and occupancy percentage for the visible date range (shown as a tiny inline bar or percentage). Hovering a property name highlights its entire row.

**Why this priority**: Adds valuable at-a-glance metrics without requiring the manager to count bars manually. Enhances the data density of the view.

**Independent Test**: Load the calendar and verify each property row in the sidebar shows correct active booking count and occupancy percentage matching the visible date range.

**Acceptance Scenarios**:

1. **Given** a property has 3 bookings in the visible 2-week range covering 10 of 14 nights, **When** viewing the calendar, **Then** the sidebar shows "3 bookings" and "71% occupied" (or equivalent visual)
2. **Given** a property name is long, **When** viewing the sidebar, **Then** the name truncates with an ellipsis and the full name shows on hover

---

### Edge Cases

- What happens when a property has back-to-back reservations (same-day checkout/checkin)? The bars should touch but not overlap — checkout date belongs to the departing guest, checkin date to the arriving guest
- What happens when a reservation is only 1 night? The bar should still be visible as a minimum-width element (not invisible)
- What happens when there are 50+ properties? The sidebar should be scrollable independently of the date header, which stays fixed
- What happens when pricing data is temporarily unavailable? Empty cells show a subtle placeholder (e.g., "---") instead of breaking the layout
- What happens on a narrow screen (laptop)? The sidebar collapses to property names only (no metrics), and day columns narrow proportionally
- What happens when a reservation is cancelled? It should not appear on the calendar by default (only active statuses shown)

## Requirements

### Functional Requirements

- **FR-001**: System MUST display all tenant properties as rows in a left sidebar with property name
- **FR-002**: System MUST display a horizontal date timeline as column headers with day number and weekday abbreviation (e.g., "M 6", "T 7", "W 8")
- **FR-003**: System MUST render reservations as horizontal bars spanning check-in to check-out columns, showing guest first name and guest count
- **FR-004**: System MUST show nightly prices in available (unbooked) date cells via a new backend endpoint that fetches and caches per-property calendar pricing from the booking platform
- **FR-005**: System MUST highlight today's column with a distinct visual indicator (vertical line or background tint)
- **FR-006**: System MUST provide navigation controls: "Today" button, forward/back arrows (7-day shift), and a visible month/year label. Navigable range: 2 months into the past, 6 months into the future
- **FR-007**: System MUST support two view modes: 2-week view (default) and month view (30 days)
- **FR-008**: System MUST color-code reservation bars by booking channel (Airbnb, Booking.com, Direct, WhatsApp, Other) using distinct pastel colors
- **FR-009**: System MUST display a channel icon on each reservation bar
- **FR-010**: System MUST visually distinguish reservation statuses — confirmed (solid), inquiry/pending (dashed/striped pattern), checked-in (accent highlight)
- **FR-011**: System MUST show a rich tooltip on reservation hover containing: guest full name, channel icon + name, check-in/check-out dates, nights, guest count, total price with currency symbol (e.g., €650.00)
- **FR-012**: System MUST allow clicking a reservation bar to navigate to that reservation's conversation in the inbox
- **FR-013**: System MUST provide a search/filter input to filter properties by name in real-time
- **FR-014**: System MUST keep the date header row fixed (sticky) while scrolling vertically through properties
- **FR-015**: System MUST keep the property sidebar fixed (sticky) while scrolling horizontally through dates
- **FR-016**: System MUST show weekend columns with a subtly different background tint to aid visual scanning
- **FR-017**: System MUST only show active reservations by default (exclude CANCELLED and CHECKED_OUT statuses)
- **FR-018**: System MUST handle back-to-back reservations (same-day checkout/checkin) without visual overlap
- **FR-019**: System MUST render single-night reservations as a minimum-width bar that remains visible and clickable
- **FR-020**: System MUST provide a loading skeleton during data fetch that mirrors the calendar structure
- **FR-021**: System MUST show occupancy percentage per property in the sidebar for the visible date range

### Visual Design Requirements

- **VD-001**: Reservation bars MUST use softly rounded corners (pill-shaped) with a subtle drop shadow on hover
- **VD-002**: The overall color palette MUST be light and airy — white background, light gray grid lines, pastel reservation colors
- **VD-003**: Typography MUST be clean and minimal — property names in medium weight, dates in light weight, prices in muted/secondary color
- **VD-004**: Transitions between date ranges MUST be smooth (slide animation, not instant swap)
- **VD-005**: Hover states MUST have subtle, polished feedback — bars slightly elevate/glow, row highlights, cursor changes
- **VD-006**: The "Today" marker MUST be a thin vertical accent line spanning the full calendar height, using the primary brand color
- **VD-007**: Empty price cells MUST use a small, muted font so prices don't compete visually with reservation bars
- **VD-008**: The calendar grid MUST feel spacious — adequate row height for bar readability, padding around elements, no cramped layout
- **VD-009**: Channel colors MUST be harmonious pastels: Airbnb (soft coral/salmon), Booking.com (soft blue), Direct (soft green), WhatsApp (soft emerald), Other (soft gray)
- **VD-010**: The tooltip MUST appear with a subtle fade+slide animation, not a hard pop-in

### Key Entities

- **Property**: A rental unit belonging to a tenant. Key attributes: name, booking platform listing ID, knowledge base
- **Reservation**: A booking for a property. Key attributes: check-in date, check-out date, guest count, channel, status, total price, payout amount, currency, cleaning fee, guest name
- **Calendar Day**: A date cell that is either booked (contains a reservation bar) or available (shows nightly price). Derived from reservation and pricing data
- **Guest**: The person who made the booking. Key attributes: name, nationality

## Success Criteria

### Measurable Outcomes

- **SC-001**: Managers can identify which properties are available for a given date within 3 seconds of opening the calendar
- **SC-002**: Managers can view full booking details (guest, dates, price, channel) in 2 interactions or fewer (open page + hover)
- **SC-003**: Calendar page loads and renders all properties and reservations within 2 seconds for portfolios of up to 50 properties
- **SC-004**: Managers can navigate to any date within the range of 2 months past to 6 months forward in under 5 seconds
- **SC-005**: (Post-launch goal) 90% of managers prefer the calendar view over switching to the booking platform's calendar for daily availability checks
- **SC-006**: Property search/filter returns results as the user types, with no perceptible delay
- **SC-007**: The calendar is usable on screens as small as 13" laptops without horizontal scrollbar on the sidebar

## Assumptions

- Nightly pricing data is fetched from the booking platform's calendar API per property, requiring a new backend endpoint with caching to avoid repeated API calls
- Reservation financial data (total price, payout, currency, cleaning fee) is synced from the booking platform and stored locally on the Reservation model — no live API calls needed for tooltip price display
- Guest names are available through the existing guest records linked to reservations
- The calendar is read-only — managers use the booking platform for creating or editing reservations
- Currency is stored per-reservation but expected to be consistent within a tenant (no multi-currency formatting logic needed)
- Maximum portfolio size is ~50 properties per tenant
- The calendar page is a new top-level navigation item alongside existing pages (Inbox, Listings, Tasks, etc.)

## Out of Scope

- Creating, editing, or cancelling reservations from the calendar
- Drag-and-drop to move or resize reservations
- Revenue/financial reporting (this is an availability/overview tool, not an analytics tool)
- iCal/Google Calendar sync or export
- Multi-tenant calendar view (each tenant sees only their own properties)
- Blocking dates or setting minimum stays from the calendar
