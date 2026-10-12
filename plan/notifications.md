# Notifications plan: staff hear about a new booking request and a proof to verify, on the screen and on their phone

> Two things wait on staff today and nothing tells them: a guest's
> **booking request** (born `pending` on S-6, D-070) and a guest's
> **payment proof** (status `submitted`, D-107). Both are counted already,
> `manage_attention()` and the dashboard's `attention` card (D-098), but
> a count is only seen by someone who opens the page. This plan adds two
> layers:
>
> 1. **In the app** (works today, local): while any staff page is open, the
>    sidebar shows a badge on Requests and Payments, the tab title gains
>    `(2)`, and a new arrival plays a short sound and a toast.
> 2. **Web Push** (Phase 4 onward; a real phone needs deployment): a
>    member who taps "Notify me on this device" gets a system notification,
>    with the OS's sound, even with the tab closed; on Android with Chrome
>    closed, on iPhone once the site is on the Home Screen, on a desktop
>    while the browser runs (a quit browser gets it on next launch, within
>    the TTL).
>
> No Firebase: standard Web Push with VAPID reaches Chrome, Edge, Firefox
> and Safari through their own push services.
>
> Written 2026-10-13, against `107d6fb` on `feat/conversations`.
> **Status: not started; § 7 decided 2026-10-13 (every recommendation taken).** The record will be
> D-116 (D-115 is the conversations plan's), R-51, and the SQL file the
> 29th (`schema-notifications.sql`; the 28th is conversations').
>
> Read [§ 0](#0-the-five-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | Phase 1: `GET /api/t/[tenant]/admin/attention` (any member, `dashboard:read`) over `manage_attention()` + the pending-request count, polled by `StaffFrame` while the tab is visible; badges, title count, a sound (Web Audio, no file) and a toast on a rise; a per-device "Sound" toggle. Phases 2–6: `push_subscriptions` and `notification_outbox` (SQL, RLS), one trigger on `booking_events` that fills the outbox, `@rag/push` (VAPID JWT + RFC 8291 payload encryption over raw `fetch`, `node:crypto`), a per-tenant service worker and web app manifest, subscribe / unsubscribe routes, the drain. verify, isolation, a walk; the record |
| **Out of scope** | Email (manage-booking Phase 7, Resend, still gated on deployment; the outbox is shaped so email can be a second channel later, § 7 q7). Notifying GUESTS of anything. SMS, Viber, Messenger. A notification inbox / history screen (the event log on S-15 is the history). Custom notification sounds (the OS chooses; § 2b.5). Notifying on staff's own actions. Any change to the chatbot |

### What the request assumes, and what is actually here

| Assumption | What exists today | What the plan does |
|---|---|---|
| "We know when a booking or a payment arrives" | Yes, in ONE place: every booking insert, status change, proof and change request is a `booking_events` row written by a definer trigger (D-109), with `actor_kind` `guest` / `staff` / `system` | One AFTER INSERT trigger on `booking_events` writes the outbox (Rule 1). No route has to remember anything |
| "Staff can see the counts" | `manage_attention(p_tenant_id)` (staff only) and `tenant_dashboard()`'s `attention`: `pendingRequests`, `proofsToVerify`, `changeRequests` | Phase 1 polls a small route over the same counts; no new SQL for layer 1 |
| "Realtime is the obvious in-app channel" | Supabase Realtime would need a staff TOKEN in the browser, and a `TenantContext` never reaches a Client Component (CLAUDE.md conventions); tokens last 5 minutes | Poll instead (§ 7 q1): one cheap count every 30 s, paused when the tab is hidden |
| "A push needs Firebase / a library" | No. VAPID is an ES256 JWT, which `mintTenantToken()` already signs with `node:crypto`; the payload encryption is RFC 8291 (ECDH P-256 + HKDF + AES-128-GCM), all in `node:crypto` | `@rag/push`, hand-written, checked against RFC 8291 Appendix A's test vector (§ 7 q6) |
| "It works on my phone now" | Push subscription needs a secure context. `localhost` is one (desktop testing works today); a phone on the LAN is not. The project is local only (D-013) | Phases 2–5 are built and tested on desktop localhost; the phone walk waits for deployment or a tunnel (§ 7 q8) |

---

## 0. The five rules

### Rule 1 — The event log is the one source

A notification exists because a `booking_events` row does. The trigger
`booking_events_notify` inserts into `notification_outbox` in the same
transaction as the event; a route never "also sends a push". The SEND
happens after commit, so a push service that is down never undoes a
booking or a proof (the reason Phase 7 of manage-booking chose an outbox).

### Rule 2 — A push carries nothing a lock screen should not show

The payload is: kind, the stay's reference, the first night and the
number of nights (for a request), and a link path. **No guest name, phone,
email or amount** (§ 7 q4). It is encrypted to the device, but it is shown
on a lock screen, and the push service is a third party. The payload is
built from named fields, never spread from a row (as tool results, rule 7).

### Rule 3 — Who receives is decided at send time, from the membership row

The drain joins `push_subscriptions` to the CURRENT `memberships` row and
asks `lib/permissions.ts`'s rule in SQL: a booking request goes to roles
with `bookings:write` (owner, admin, staff), a proof to roles with
`payments:write` (owner, admin). A removed member, or one demoted to staff,
stops getting proofs on the next send, not when the subscription expires.
A subscription is per (tenant, user, device); a person in two tenants has
two, and villa's events never reach a northwind-only member (both walls,
rule 6).

### Rule 4 — The VAPID private key is a secret like the signer

`VAPID_PRIVATE_JWK` is read in ONE function in `@rag/push`, server only
(`server-only` import), never `NEXT_PUBLIC_`. The public key reaches the
browser as a prop from the server page (the photo-limits convention). The
rule-2 grep of `apps/web/.next/static/` gains `VAPID_PRIVATE`. With the
key unset, layer 2 is off and says so; layer 1 still works.

### Rule 5 — The chatbot does not change

No prompt text, no tool text. The three snapshot baselines stay
byte-identical; `pnpm eval` once at the end as a regression check
(59/61 expected).

---

## 2b. Traps

### 2b.1 A sound needs a gesture

Browsers block audio until the page has had a user interaction. The
"Sound on" toggle in the sidebar IS that interaction; it is stored per
device in `localStorage` (a per-viewer convenience, wrapped in try/catch).
A page reloaded with sound "on" but no click yet stays silent until the
first click anywhere, and the toggle says so.

### 2b.2 The permission prompt only from a tap

`Notification.requestPermission()` is called from the "Notify me on this
device" button, never on load: Chrome quiets sites that ask on load, and
iOS refuses outright. A `denied` permission cannot be re-asked by the
page; the button then says where to change it in the browser.

### 2b.3 iPhone needs the Home Screen

iOS (16.4+) gives Web Push only to a site added to the Home Screen, which
needs a web app manifest. The manifest is per tenant
(`/t/<slug>/manifest.webmanifest`, the business name, the theme colour,
`start_url` `/t/<slug>/admin/dashboard`, `scope` `/t/<slug>/`), and the
button on iOS Safari says "Add to Home Screen first" instead of asking.

### 2b.4 One service worker per tenant scope

A registration has one push subscription. A worker at `/t/<slug>/sw.js`
(served by a route handler, `Cache-Control: no-cache`, so an update is
seen) has scope `/t/<slug>/`, so a person in villa and harbor on one
device has two registrations and two subscriptions, each its tenant's.

### 2b.5 The sound of a push is the OS's

A system notification plays the device's notification sound (unless the
phone is silenced or the site's notifications are muted). There is no
reliable way to choose a custom sound; `silent: false` is all the worker
sets. The custom sound exists only in layer 1.

### 2b.6 Dead subscriptions

A push service answers 404 or 410 for a subscription that is gone
(uninstalled, cleared). The drain deletes that row. 429 and 5xx are
retried (`attempts` ≤ 5, then dropped and counted in the log). TTL is
24 h with `Urgency: high`, so a desktop browser opened the next morning
still gets last night's request, and nothing older.

### 2b.7 Not every event is news

The trigger notifies only:
- `created` with `actor_kind = 'guest'` and `to_value = 'pending'` (a web request; one event per statement, so a 3-night stay is ONE push),
- `payment` with `to_value = 'submitted'` (a proof sent),
- `change` with `to_value = 'pending'` (a guest asks to cancel or move; § 7 q2).

Staff-made stays, decisions, the expiry sweep (`actor_kind = 'system'`) and
refunds are not news to anyone (§ 7 q3).

### 2b.8 The drain runs where there is no staff token

A guest's request runs on a CHAT token, which cannot read another user's
subscriptions, and the service key is forbidden in `apps/` (rule 2). So
the drain is a definer, `notify_claim(p_tenant_id)`: it checks the tenant
is the token's (wall 2), atomically marks up to 50 unsent outbox rows of
THAT tenant as claimed, and returns them joined to their recipients'
endpoints and keys (Rule 3's join). Without the VAPID private key those
keys send nothing, and a claimed row is consumed, so the function cannot
be used to list subscriptions repeatedly. `notify_done()` records the
result per subscription. A claim older than 5 minutes is re-claimable (a
drain that crashed).

### 2b.9 Polling cost

One attention read per 30 s per OPEN, VISIBLE staff tab, over indexed
counts. Hidden tabs stop polling (`visibilitychange`) and read once on
return. The route returns numbers only.

---

## 3. The data model (`schema-notifications.sql`, the 29th file)

```sql
-- push_subscriptions (id, tenant_id, user_id uuid, endpoint text unique, p256dh text, auth text,
--                     kinds text[] default '{request,proof,change}', user_agent text ≤ 200,
--                     created_at, last_ok_at, failures int default 0)
--   FK (tenant_id, user_id) → memberships, on delete cascade: a removed member's devices go too.
--   endpoint must be https and ≤ 1000 chars; p256dh / auth base64url, checked lengths.
--   RLS: a member selects, inserts and deletes ONLY rows with user_id = auth.uid()
--        and tenant_id = app_tenant_id() and app_is_staff(). No update policy (re-subscribe = delete + insert).
--
-- notification_outbox (id, tenant_id, event_id → booking_events, kind 'request'|'proof'|'change',
--                      reference text, first_night date, nights int, created_at,
--                      claimed_at, sent_at, attempts int default 0)
--   No policy for any token: written by the trigger, read by notify_claim() (definer).
--
-- booking_events_notify: AFTER INSERT on booking_events, FOR EACH ROW, security definer,
--   search_path = '' (trap 19), inserts one outbox row for the three kinds in § 2b.7.
--
-- notify_claim(p_tenant_id) → table(outbox_id, kind, reference, first_night, nights,
--                                   subscription_id, endpoint, p256dh, auth)   -- definer, the 13th
-- notify_done(p_results jsonb)  -- per subscription: ok | gone | retry; deletes gone rows,
--                                  sets sent_at when every recipient answered    -- definer, the 14th
```

The role → kind rule lives in SQL inside `notify_claim()` (`request` and
`change`: any role; `proof`: owner or admin) and in `lib/permissions.ts`.
A unit test asserts the two agree, as `navItems()` is tested against the
table.

---

## 4. The pieces

### Layer 1 — in the app

- `GET /api/t/[tenant]/admin/attention` → `{ requests, proofs, changes }`.
- `StaffFrame` polls it; `navItems()` gains an optional `badge` count for
  Bookings (requests + changes) and Payments (proofs, only for roles with
  `payments:read`).
- `document.title` gets `(n) ` in front while n > 0.
- On a rise: `useNotice()` toast ("New booking request", "A proof to
  verify"), and a two-tone chime from an `OscillatorNode` if sound is on.
  No audio file.

### Layer 2 — Web Push

- `packages/push` (`@rag/push`): `vapidHeader(audience)`,
  `encryptPayload(json, p256dh, auth)` (RFC 8291 `aes128gcm`),
  `sendPush(sub, payload)` over `fetch`, returning `ok | gone | retry`.
  Zero runtime dependencies; `server-only`.
- `/t/<slug>/sw.js` (route handler): `push` → `showNotification(title,
  { body, tag: reference, data: { path } })`; `notificationclick` →
  focus an open tab of the tenant or open `path` (S-15 for a request or a
  change, S-14 for a proof).
- `/t/<slug>/manifest.webmanifest` (route handler, from `tenant_public()`).
- `POST/DELETE /api/t/[tenant]/admin/push` (permission `session`): store or
  remove THIS device's subscription. `POST` validates the endpoint's host
  against the known push services' suffixes (a stored endpoint is a URL
  the server will POST to: no SSRF to an internal host).
- Sidebar: "Notify me on this device" / "Notifications on · Turn off",
  with the per-kind checkboxes for this device.
- The drain, `drainNotifications(tenant)` in `@rag/push`'s caller
  (`packages/bookings/src/notify.ts`): `notify_claim` → `sendPush` each →
  `notify_done`. Called after the write succeeds in `book/request`, `manage/proof` and `manage/change`
  (`after()` from `next/server`, so the guest's response is not delayed),
  and by the attention poll (a staff token: the sweep that catches a
  failed drain).

---

## 5. Phases

### Phase 0 — Baseline
verify, both isolations, rooms, the three snapshots, the a11y count;
written down before anything moves.

### Phase 1 — In the app (no SQL)
The attention route, polling, badges, title, toast, chime, the Sound
toggle. Unit tests for `navItems()` with badges. Walk: two browsers,
a web request in one, the badge and chime in the other within 30 s.
**Useful on its own; can ship before the rest.**

### Phase 2 — SQL
`schema-notifications.sql`. verify gains: a member inserts and deletes
its own subscription; another member's row is invisible and undeletable
(and its positive twin, trap 12); a chat token reads 0 subscriptions and
0 outbox rows; a web request makes ONE outbox row per stay, a staff stay
none; `notify_claim` refuses another tenant; a staff role gets no `proof`
rows; a claimed row is not returned twice; a removed member's
subscriptions are gone.

### Phase 3 — `@rag/push`
VAPID and RFC 8291, tested against the RFC's Appendix A vector byte for
byte, and a VAPID JWT verified with the public key. No network.

### Phase 4 — Worker, manifest, subscribe
The two route handlers, the subscribe routes, the sidebar control,
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_JWK` / `VAPID_SUBJECT` in `env.ts`
(OPTIONAL: unset = layer 2 off). A `tools/vapid.mjs` that prints a new
key pair.

### Phase 5 — The drain
`notify.ts`, the three call sites, the sweep in the poll. Walk on desktop
Chrome on localhost: subscribe, close the tab, make a web request from
another browser, see the system notification; click it, land on S-15.
Repeat with the browser minimised, then with a proof (owner sees it, a
staff member does not).

### Phase 6 — The walls and the phones
isolation gains: villa's request reaches no harbor-only member; filters
alone and RLS alone. `grep -r VAPID_PRIVATE apps/web/.next/static/`
empty. Phone walk (Android Chrome closed; iPhone from the Home Screen)
**gated on deployment or a tunnel** (§ 7 q8).

### Phase 7 — The record
D-116, R-51 (pushes leave through Google / Apple / Mozilla; payload is
minimal and encrypted; a lost phone keeps getting pushes until its
subscription is removed, so "Turn off on all devices" exists on the
member's own row), CLAUDE.md paragraph and layout lines, status.md,
whats-done.md, and `pnpm eval` once.

---

## 6. What must not change

- The chatbot: prompt, tools, three baselines.
- `booking_events`: its writers and its rows. The new trigger only reads
  `NEW`.
- Every existing route's response and timing for the guest (`after()`).
- `createBookings()`, `request_booking()`, `submit_payment()`,
  `request_change()`: untouched. Notification is a side effect of the log,
  not of them.
- Rule 2 of CLAUDE.md: no service key in `apps/`, the static grep empty.

---

## 7. Questions · **decided 2026-10-13: every recommendation taken**

1. **In-app channel: polling or Supabase Realtime?** **Decided: polling.**
   Realtime would put a staff token in the browser and need a refresh loop
   every 5 minutes; a 30 s poll of three counts is simpler and fits D-002.
2. **Notify on guest change requests too?** **Decided: yes,** same
   recipients as a booking request. The user asked for bookings and
   payments; this one is the third thing waiting on staff.
3. **Notify on staff-made stays?** **Decided: no:** the person who made it
   knows; others see it in the list.
4. **Put the guest's name in the push?** **Decided: no** (Rule 2). The
   reference and dates are enough to act on; the name is one tap away.
5. **What drains the outbox?** **Decided: in-request (`after()`) plus the
   staff poll as a sweep.** Alternatives: a Supabase Edge Function on a
   database webhook (holds the service key outside `apps/`, adds Deno), or
   a cron (needs deployment). Revisit a cron at deployment.
6. **Hand-write the push protocol or use the `web-push` package?**
   **Decided: hand-written:** ~150 lines of `node:crypto`, the RFC ships a
   test vector, and "no library does a pipeline step" is the house rule.
   `web-push` is the fallback if Phase 3's vector will not match.
7. **Email as well?** **Decided: later,** as manage-booking Phase 7 planned:
   the outbox gains a `channel`, Resend is a second sender. Not in this
   plan.
8. **Test on a real phone before deployment?** **Decided: a tunnel**
   (`cloudflared tunnel --url http://localhost:3000`) for the Phase 6
   walk only; production push waits for deployment (D-013).
9. **Per-kind opt-out per device?** **Decided: yes,** `kinds` on the
   subscription, three checkboxes. An owner may want proofs on the phone
   and requests only on the desk.
