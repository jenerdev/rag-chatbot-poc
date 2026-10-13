# Platform header: the staff app's top bar, for the super user (2026-10-14, D-119)

> The user asked (2026-10-14): improve the layout and UI/UX of the platform
> page's header. Done the same day on `feat/platform-header`; no SQL, no
> route, no permission changed.

## What was wrong (`plan/platform-header/before-*.png`)

- **The header was a bare line:** "Platform · Tenants" and an underlined
  "Log out" link. Nothing said who was signed in, and it looked unlike the
  staff app's top bar (D-117).
- **No way back from a tenant in the header:** the subtitle changed to the
  tenant's name, but led nowhere.

## What changed

- **The staff app's top bar (`.staff-topbar`), with the platform's own
  identity.**
  - It has a mark (a filled square in the default accent; the platform has
    no tenant theme) and "Platform".
  - A breadcrumb follows: "Tenants", or "Tenants › {tenant}", where
    "Tenants" leads back to the list.
- **The account menu (`AccountMenu`, D-117) on the right,** labelled "Super
  user", with Log out. It takes an optional `label` now, for an account
  that is not a tenant role. The session has no email to show: it returns
  the user id only, because the platform token cannot read `auth.users`.
- **Its edges are the page's under it:** 1120 px for the list, 1040 for a
  tenant's form.
- **On a phone** the breadcrumb stays and the name gives way.
- **Signed out,** "Platform" is the page's `<h1>`: the login card's title is
  an `<h2>`, and the old header had been the h1.

## Evidence

- **`plan/platform-header-check.mjs`:**
  - **walk 5/5:** the list's bar; a tenant's breadcrumb; the bar lines up
    with the page (140 = 140); the breadcrumb leads back; Log out from the
    menu;
  - **axe:** 16 states (login, list, menu open, tenant; 1280 and 375;
    light and dark), **0 violations**.
- **Two misses on the way:**
  - the login had lost its `<h1>`;
  - then, at 375, the phone rule hid it again. Both were fixed.
- **Typecheck and tests:** typecheck exit 0, 159 web tests.
- **Screenshots:** `plan/platform-header/after-*.png` (before: `before-*`).
