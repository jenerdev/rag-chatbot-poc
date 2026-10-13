# Room cards and the photo viewer, redrawn (2026-10-14, D-120)

> The user asked (2026-10-14): improve the layout and UI/UX of the chat's
> room cards (D-094), and of the photo viewer. Done the same day on
> `feat/room-cards`. The DATA is unchanged: the cards are still the reply's
> pipe table, joined to the rooms' photos by name. No pipeline, prompt or
> tool change, so the chatbot baselines are untouched.

## What was wrong (`plan/room-cards/before-*.png`)

- **Cards:**
  - every cell was a "label / value" row with a fixed 34% label column, so
    a description wrapped in a narrow column under "Details";
  - on a phone each room filled a screen, six rooms one under another;
  - the photo count was a small grey pill, with no sign the photo opened
    anything.
- **Viewer:**
  - the × and the "1 / 2" sat on the photo's corners;
  - on a phone the photo was a small strip in the middle of the screen;
  - nothing named the room;
  - the only ways between photos were stepping and swiping.

## What changed

- **Cards (`room-cards.tsx`):**
  - a SHORT cell (≤ 32 characters, not a sentence) is a fact chip under the
    name, "Guests **up to 3**";
  - a long cell, or any sentence, is the card's text, labelled only when
    there is more than one (`cardParts()`, tested);
  - the photo is 3:2 with a gentle zoom on hover, and the badge says
    "🖼 2 photos";
  - **on a phone the cards are one row** that scrolls sideways with snap,
    each card 84% wide, so the next room shows at the edge;
  - the row is a focusable named region ("Rooms"), so a keyboard can
    scroll it;
  - the photo button's name contains its badge's words, "See 2 photos of
    Casa Uno" (WCAG 2.5.3, which axe caught).
- **Viewer (`lightbox.tsx`):**
  - a bar with the room's name, "1 of 2" and Close: nothing sits on the
    photo;
  - the photo is as large as fits, with the arrows beside it (over its
    edges on a phone);
  - **a thumbnail strip**: any photo in one tap (`to(index)`);
  - Tab stays inside the dialog;
  - the backdrop is near-solid (`--viewer-bg`, 0.95, plus a blur), because
    at 0.88 the page's header showed through behind the room's name;
  - kept: focus to Close on open and back to the photo on close, Escape,
    the arrow keys, swipe, a click on the dark around the photo.

## Evidence

- **`plan/room-cards-check.mjs`,** on alteza's real reply to "What rooms
  are available?":
  - **walk 7/7:**
    - chips, and every photo button's name containing its badge;
    - the viewer named by room and photo, focus on Close;
    - 8 Tabs inside;
    - an arrow steps (2 of 2) and a thumbnail jumps back (1 of 2);
    - Close is off the photo;
    - Escape returns focus to the photo;
    - on a phone, a sideways row (card 248 px in a 295 px row);
  - **axe:** 8 states (cards and the open viewer; 1280 and 375; light and
    dark), 0 violations after the label fix.
- **Typecheck and tests:** typecheck exit 0, web tests 163 (the room-card
  test updated, `room-cards.test.ts` new).
- **Screenshots:** `plan/room-cards/after-*.png` (before: `before-*`).

**Superseded:** `plan/ui-refresh-phase4-walk.mjs`'s lightbox selectors
(`.lightbox-frame`). This file's check replaces them.
