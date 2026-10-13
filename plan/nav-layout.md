# Nav layout: a sidebar of places, a top bar for you (2026-10-14, D-117)

> The user asked (2026-10-14): improve the sidebar's layout and grouping, and
> create a top bar and move items into it where that is better. Done the
> same day on `feat/nav-layout`; no SQL, no route, no permission changed.

## What was wrong (`plan/nav-layout/before-*.png`)

1. **The groups mixed two kinds of work.**
   - "Bookings" held the daily work (Bookings, Calendar, Payments) beside
     what is set up once (Rooms, Slots, Holidays, Promos).
   - "Content" held the chat inbox (Conversations, Unanswered) beside the
     Knowledge base. "Team" was one link.
2. **The footer held three different things:** the guest pages (Chat,
   Book), this device's settings (Sound, push), and the account (role,
   Log out). On a phone the drawer was long enough to push Log out out of
   sight.
3. **No top bar on a desktop.** The Notifications item, a bell by nature,
   sat in the list.

## What changed

- **The sidebar is navigation only, in four sections, by what staff are
  doing.** Groups follow the work, not the database table.
  - **Overview:** Dashboard
  - **Front desk:** Bookings, Calendar, Payments
  - **Assistant:** Conversations, Unanswered, Knowledge base
  - **Setup:** Rooms, Slots, Holidays, Promos, Members (owners and admins
    only; staff see three sections)
- **A top bar on every width.**
  - Left: a breadcrumb (section › page), lined up with the page title. On
    a phone, the menu button and the business name instead.
  - Right: the Notifications **bell** with the ONE badge, and the **account
    menu**. The menu holds the role, the guest pages (Chat page, Booking
    page), this device (Sound, push), and Log out.
- **The account menu is a disclosure, not an ARIA menu.**
  - It holds checkboxes and links, which Tab walks as it would any region.
  - Escape closes it and returns focus to its button. A press outside, or
    focus leaving it, closes it too.
  - It stays mounted while closed, so push's state survives.
- **Which links exist is unchanged.** `navItems()` still decides; only the
  order and the placing moved (`groupNavItems()` returns `groups`,
  `topItems`, `publicItems`; `groupOf()` names a page's section).

## Evidence

- **`plan/nav-layout-walk.mjs`, 19/19:**
  - the owner's four sections and the staff member's three;
  - no footer;
  - the breadcrumb at the page title's x (316 = 316);
  - the bell named and linked;
  - the account menu: closed on load; the role, the guest pages, the
    device and Log out inside; Escape returns focus; a press or focus
    outside closes it;
  - the phone: menu, business, bell and account in the top bar; the
    drawer traps focus, and its last link ends at 644 px of 812; the
    panel fits 375 px;
  - Log out from the menu.
- **`plan/nav-layout-a11y.mjs`:** 10 states (the frame, the menu open, the
  drawer open; 1280 and 375; light and dark), 0 violations.
- **The notification walks, moved to the bell:** inbox 12/12, sound 5/5,
  `notifications-a11y.mjs` 8 states with 0 violations.
- **Typecheck and web tests:** typecheck exit 0, 159 web tests.
- **Screenshots:** `plan/nav-layout/after-*.png` (owner and staff, light
  and dark, 1280 and 375, the menu and the drawer open).

**Superseded:** `plan/ui-refresh-phase2-walk.mjs` checks 1d, 1e, 2b and 7 (the
desktop with no top bar, the footer's links and role, Log out in the
footer); `nav-layout-walk.mjs` checks the same things where they now are.
