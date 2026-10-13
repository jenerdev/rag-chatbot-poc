# The landing page (2026-10-14, D-121)

> The user asked (2026-10-14, item 1 of 5): a static landing page for the
> chatbot and booking management, showing what it does and its advantages,
> with no pricing yet.

## What it is

The root (`/`, `app/page.tsx`, `app/styles/landing.css`) became a static
landing page, sectioned top to bottom:

- **The hero:** "Your front desk, open around the clock", with a lede, two
  calls to action and three ticks.
- **Features:** six of them. Answers from your own information; speaks
  English, Taglish and Tagalog; live availability and prices; a booking
  page of your own; staff hear it the moment it arrives; your brand.
- **How it works:** three steps.
- **Why resorts use it:** six advantages.
- **"Already have a workspace?"**

**No pricing.** The product's name is a working one, `StayDesk`, held in
one constant at the top of `page.tsx`.

**The pictures are MOCKUPS,** drawn in HTML and CSS with made-up content: a
chat exchange, a room card, a "Book your stay" button and a staff
notification. They are never screenshots, because the test tenants' names,
prices and guests are real data, and plan.md Phase 7 still holds: the root
lists no tenant and redirects to none. A Server Component with no data;
tokens only; it follows light and dark.

## Evidence

`plan/landing-check.mjs` takes screenshots of every section into
`plan/landing/`, and runs axe at 1280 and 375, light and dark: **4
states, 0 violations**.

The screenshots caught two layout bugs, both fixed:
- "How it works" was out of line with the other sections: a more specific
  `margin: 0` cancelled the band's centring, so the band is now a wrapper.
- On a phone, the notification mockup covered the mockup's button: below
  900 px it sits under the window.
