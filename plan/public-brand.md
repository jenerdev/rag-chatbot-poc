# Public brand: the chat, the booking page and Manage booking look like their tenant (2026-10-14, D-118)

> The user asked (2026-10-14): improve the layout of the chat page and the
> booking page's header and banner, since those pages are public, and make
> them more branded from the tenant's configuration. Done the same day on
> `feat/public-brand`. It uses ONLY what a tenant can already set: business
> name, assistant name, logo URL, banner URL, the five theme colours,
> suggested questions. No SQL, no route, no new setting.

## What was wrong (`plan/public-brand/before-*.png`)

1. **The banner was a 96 px strip** above a plain white header, on the chat
   only. The booking page and Manage booking did not show it at all.
2. **Every tenant had the same white header** with its name in it. The
   accent showed only on the Book button, and with no logo the mark was a
   bare letter.
3. **The chat spoke to staff, in front of guests.** It said "The answer will
   show the chunks it came from". With no documents yet, it said "Your
   knowledge base is empty — add a document first" and showed a link to
   the knowledge base.
4. **"Staff login" sat in the guest's header** beside Chat.

## What changed

- **Header (every tenant page):** a 3 px stripe of the accent, and a mark:
  the logo, or the business's initial on the accent (`BrandMark`).
- **The booking page and Manage booking get a brand band**
  (`BrandHeader hero=…`):
  - it shows the banner under a scrim of the accent's deep shade, or,
    with no banner, a gradient of the accent;
  - the header sits inside the band, transparent and white;
  - the business name is set large, under a line saying what the page is
    for ("Online booking", "Your booking");
  - the header's own name is kept for screen readers only, so it is not
    said twice.
- **The chat's welcome is a card:**
  - it has the banner, or the gradient, as its cover;
  - the assistant's mark overlaps the cover;
  - it reads "Hi, I'm {assistant}", "{business}'s assistant", and a
    sentence in a guest's words;
  - the suggested questions follow;
  - where the tenant takes bookings, "Know your dates? Request a booking".
  - With no documents, it says the assistant is still being set up, with no
    staff link. The chat header no longer shows the banner strip.
- **A public footer** on the booking page and Manage booking: © the
  business, "Book a stay" (from Manage), "Manage booking" (from the
  booking page), and "Staff login", moved here from the header.
- **No Book button in the header** (the user, mid-change: redundant). The
  welcome card and the footer are the ways to the booking page.
- **Colours:** three tokens (`--hero-deep`, `--hero-scrim`,
  `--hero-scrim-light`), mixed from the accent in tokens.css. White
  (`--on-overlay`) is the text on the band. The welcome's role line is
  `--ink`, because a tenant's accent as small text failed 4.5:1 on a dark
  page.

## Evidence

- **`plan/public-brand-a11y.mjs`:** axe over the chat, the booking page and
  Manage booking.
  - It covered villa, harbor, alteza, and a throwaway tenant with a logo,
    a banner and bookings; at 1280 and 375, light and dark: 48 states.
  - The first run found 2 contrast failures (the role line, in an orange
    accent, on a dark page). Fixed, then **48 states, 0 violations**.
- **Screenshots:** `plan/public-brand/after-*.png` (before: `before-*`).
- **Typecheck and tests:** typecheck exit 0, web tests 159.
