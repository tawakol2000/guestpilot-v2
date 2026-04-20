# Quickstart: Calendar View

**Feature**: 028-calendar-view | **Date**: 2026-04-02

## Scenario 1: First Load — Calendar with Reservations

**Setup**: Tenant has 5 properties, 8 active reservations in current 2-week range

**Steps**:
1. Navigate to Calendar page (new nav item)
2. Page shows loading skeleton (property rows + date columns shimmer)
3. Two parallel API calls fire:
   - `GET /api/reservations?startDate=<7daysAgo>&endDate=<7daysAhead>` — returns 8 reservations with guest names
   - `GET /api/properties/calendar-bulk?startDate=<7daysAgo>&endDate=<7daysAhead>` — returns per-night pricing for all 5 properties
4. Calendar renders: 5 property rows, 14 date columns, 8 colored reservation bars, nightly prices in empty cells
5. Today's column has a blue vertical accent line
6. View auto-scrolls horizontally so today is centered

**Expected Result**: All bars positioned correctly, prices visible, today highlighted, loads in < 2 seconds

---

## Scenario 2: Navigate Forward and Back

**Setup**: Calendar loaded at current 2-week view

**Steps**:
1. Click forward arrow (>)
2. View slides right, showing next 7 days (dates shift by 7)
3. New pricing data fetches for newly visible dates
4. Click "Today" button
5. View slides back to center on today's date

**Expected Result**: Smooth slide transitions, no layout flash, cached data loads instantly

---

## Scenario 3: Hover and Click Reservation Bar

**Setup**: Calendar showing a Booking.com reservation for "Nicole Zagorac" (Apr 6-19, 2 guests, EUR 1,613.27)

**Steps**:
1. Hover over Nicole's blue reservation bar
2. Tooltip fades in showing:
   - Nicole Zagorac
   - Booking.com icon + "Booking.com"
   - Apr 6 → Apr 19 (13 nights)
   - 2 guests
   - €1,613.27
3. Click the bar
4. Redirects to Inbox with Nicole's conversation open

**Expected Result**: Tooltip appears in < 150ms, shows all fields, click navigates correctly

---

## Scenario 4: Back-to-Back Reservations

**Setup**: Property "Apartment 104" has:
- Saif Bdeir checking out Apr 5
- Jahearie Mcneish checking in Apr 5

**Steps**:
1. View calendar for Apr 1-14
2. Both bars are visible on Apr 5's column
3. Saif's bar ends at midpoint of Apr 5 cell
4. Jahearie's bar starts at midpoint of Apr 5 cell

**Expected Result**: Bars touch but don't overlap, both are hoverable independently

---

## Scenario 5: Filter Properties by Name

**Setup**: 20 properties displayed

**Steps**:
1. Type "B 3" in the search filter
2. Only "B 3.17 (Omar)" remains visible
3. Clear the filter
4. All 20 properties reappear

**Expected Result**: Instant filtering as user types, no API calls (client-side filter)

---

## Scenario 6: Single Night Reservation

**Setup**: A 1-night reservation exists (check-in Apr 10, check-out Apr 11)

**Steps**:
1. View the calendar including Apr 10
2. The reservation bar spans just the Apr 10 column
3. Bar has minimum width (at least 32px) to remain visible and hoverable
4. Hover shows correct tooltip (1 night)

**Expected Result**: Bar is visible, clickable, and shows correct data

---

## Scenario 7: Hostaway Pricing Unavailable

**Setup**: Hostaway API is down or slow

**Steps**:
1. Load calendar page
2. Reservations load successfully (from local DB)
3. Pricing call fails for some/all properties
4. Empty cells show "---" placeholder instead of prices
5. No error banner or broken layout

**Expected Result**: Graceful degradation — reservations still display, only pricing cells affected

---

## Scenario 8: Navigate to Past Dates

**Setup**: Calendar loaded at today

**Steps**:
1. Click back arrow (<) 8 times (8 weeks = ~2 months back)
2. Each click shifts view by 7 days, showing historical reservations
3. Past reservations with CHECKED_OUT status are excluded
4. Click back arrow once more (past 2-month limit)
5. Back button becomes disabled (greyed out)

**Expected Result**: Past navigation works up to 2 months, shows only active-status reservations, back button disabled at limit

---

## Scenario 9: Switch to Month View

**Setup**: Calendar in 2-week view

**Steps**:
1. Click "Month" toggle
2. View expands to show 30 days
3. Day columns narrow (from 80px to 48px)
4. Reservation bar text may truncate for short stays
5. Nightly prices use smaller font to fit narrower columns

**Expected Result**: Smooth transition, all data still visible, layout adapts to narrower columns

---

## Scenario 10: New Reservation Synced

**Setup**: A new booking comes in via Hostaway while calendar is open

**Steps**:
1. Calendar is showing current week
2. New reservation syncs via reservationSync job (every 2 minutes)
3. User navigates forward and back (or page refreshes)
4. New reservation appears as a bar with correct channel color and guest name
5. Financial data (totalPrice, currency) appears in tooltip

**Expected Result**: New reservations appear after navigation/refresh, financial data populated from sync
