# Rate limit plan: ONE count per visitor, kept in Postgres, on every open route, the chat included

> Today the per-IP limit lives in a `Map` inside `apps/web/lib/rate-limit.ts`.
> It is per server PROCESS: on Vercel every instance keeps its own count, so
> a sender who lands on five instances gets five allowances (R-39, "weak by
> design"). That was fine while the limit that held was elsewhere: the
> booking request has `request_booking()`'s per-contact cap in SQL, and a
> Manage booking lookup has `guest_stay()`'s lockout. It is not fine for
> the routes that spend OpenAI money with nothing behind them: the two
> voice routes (R-53, "a caller rotating addresses can still spend") and
> the chat, which has NO limit at all. The user asked whether the code is
> production ready; this is one of the four things owed before a public
> URL (with guest email, custom SMTP and an audit log).
>
> This plan moves the count into Postgres: ONE table, ONE `security definer`
> function that bumps a window and says yes or no in one statement, called
> by `allow()` whose callers barely change, and the chat gets the limit it
> never had. The chatbot's prompt and tools are untouched.
>
> Written 2026-10-20, against `3eb2e8f` on `master`. **Status: planned,
> nothing built.** § 7's questions wait for the user.
>
> Read [§ 0](#0-the-six-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | `rate_windows` and `rate_allow()` (`sql/schema-rate-limit.sql`, the 42nd file): a fixed window per tenant × key, bumped and judged in one statement, swept by itself. `allow()` becomes async over that function, same shape of key, same `max` per caller; its seven callers await it. The chat route gets its own window (`chat\|<tenant>\|<ip>`), and the chat screen shows the 429's words instead of "request failed". A per-tenant ceiling across every address on the two routes that call OpenAI (§ 7 q2). verify checks; a walk over HTTP; the record: D-137, R-39 closed, R-13 and R-53 amended |
| **Out of scope** | An audit log of staff actions (R-13's other half, its own plan). Staff routes behind a login (Supabase throttles the login; a member is not a stranger). `book/quote` and the room-list reads: a database read, no OpenAI, no write (§ 7 q3). The per-contact cap and the lookout lockout in SQL: they stay, as the limits that hold whoever calls. The chatbot: no prompt text, no tool text, no availability read. Any change to what `clientIp()` trusts |

### What the user asked, and what the plan does with it

| The user's words | What exists today | What the plan does |
|---|---|---|
| "do you think this code is production ready?" | Four things owed before a public URL; the shared limit is the one this plan can finish without a deployment | This plan |
| "should i add a limit on the chat route too?" | The chat route has no `allow()` call; every message is an embedding call and, past the greeting path, a chat call | A `chat` window, checked before the Accept header is read, so the 429 is one JSON body in both deliveries |
| "meaning we need to apply limit the API call? per tenant?" | Per IP within each tenant, in one process's memory | The same key, counted once for the whole deployment, plus a per-tenant ceiling across addresses on the OpenAI routes |

---

## 0. The six rules

### Rule 1 — One count, and Postgres both bumps and judges it

`rate_allow(p_tenant_id, p_key, p_max, p_window_seconds)` is ONE statement:
an `insert … on conflict (tenant_id, key, window_start) do update set count
= count + 1 returning count`, judged `<= p_max`. There is no "read the
count, then write it" (CLAUDE.md trap 8 in another coat): two instances
bumping the same key at once both see the true count, because the row
lock serialises them. The window is `date_bin(window, now(), epoch)`, so
every instance computes the same `window_start` for the same instant.

### Rule 2 — Two walls, as everywhere (D-038)

The key carries the tenant id (wall 1, the code: `chat|<tenant.id>|<ip>`),
and the function refuses a `p_tenant_id` that is not the token's
`app_tenant_id()` (wall 2), like `notify_claim()`. `rate_windows` has no
policy for any token: a chat token cannot read a stranger's visit counts,
and cannot reset its own. Only the definer function touches the table.
verify proves each wall alone, with the positive twin (trap 12): the
service client sees the row the HTTP calls made, with the count they sent.

### Rule 3 — `allow()` keeps its shape; its callers keep their words

`allow(tenant, key, max?)` returns `Promise<boolean>`. The key, the
`max` per caller (10 for a booking or Manage request, 30 for a voice call,
the chat's own policy number) and every 429 sentence are unchanged; each
caller gains an `await`. The in-memory `Map`, `windows`, is deleted, not
kept as a fallback: a fallback is a second limit nobody tests.

### Rule 4 — The database down means the request fails, not the limit opens

`rate_allow()` throwing (PostgREST error, timeout) goes through the one
error map in `lib/route.ts` as a 500, like every other query. There is no
`catch → true`: every route this guards needs the database a line later
anyway, and "fail open" would make the limit vanish exactly when the
system is under strain.

### Rule 5 — The chat is counted before anything is spent

The chat's `allow()` runs after validation and before the Accept header is
read, so a refused turn is one JSON 429 whether the client asked for a
stream or not, and no embedding, no retrieval and no model call happens.
A greeting answered in code counts too, as the voice routes' refusals do:
the window is checked first, and a stranger cannot learn which messages
are cheap. The chat screen reads the 429's words and shows them in the
turn's error slot, where "request failed" is shown today.

### Rule 6 — The chatbot is untouched

No prompt text, no tool text, no availability read, no `dates.ts` or
`language.ts` line. The three baselines must be byte-identical at the end.
The battery is not run: it calls the pipeline, not the HTTP route, and
nothing it measures is in this plan.

---

## 2. Traps

### 2.1 A count that outlives the process outlives the walk too

Today every `pnpm dev` restart empties the limit. After this plan a walk
that probes "30 calls then a 429" fails on its SECOND run inside ten
minutes, because the window is still there. Every probe sends its own
fresh `X-Forwarded-For` (locally the first entry is trusted as sent,
`clientIp()`), a random address per run. `plan/voice-phase2-walk.mjs`
step 6 is amended to do the same.

### 2.2 The function is called on the CHAT token

`tenant.db` in an open route is a chat token: no `sub`, `authenticated`,
a `tenant_id` claim. So the function is `security definer` with
`search_path = ''`, every name qualified (trap 19), granted to
`authenticated` and `service_role`, revoked from `anon` and `public`, and
checks `app_tenant_id()` itself (Rule 2). verify calls it as a token of
another tenant with villa's id and expects `insufficient_privilege`.

### 2.3 The row count grows with visitors

Every (tenant, key, window) is a row. The function deletes this key's rows
whose `window_start` is older than two windows before the upsert, one
indexed delete scoped to the key, so a key cleans itself as the `Map` did
and a one-off visitor's row is gone the next time any key is bumped. The
`retention` tool is not involved: nothing here is a person's data for
longer than twenty minutes.

### 2.4 `date_bin` needs an origin

`date_bin(interval, timestamptz, origin)`: the origin is a fixed instant
(`'2000-01-01'`), the same in every call, or two instances would compute
two windows for one moment. The function takes the window in seconds and
builds the interval itself; the caller never sends a `window_start`.

### 2.5 Trap 12: zero rows prove nothing

"A chat token reads 0 rows of `rate_windows`" passes before the table has
a row. Every verify check here makes its rows first (the positive twin)
and then shows the token cannot see them.

### 2.6 The chat screen throws on any non-OK status

`chat-screen.tsx` does `if (!response.ok) throw new Error('request
failed')`. A 429 carries words the visitor should read ("Too many
questions from here. Please wait a few minutes."), so the screen reads the
JSON body on 429 and throws with its words; every other status keeps the
generic sentence. The error is drawn where turn errors are drawn today;
no new element.

---

## 3. The data model

`packages/db/sql/schema-rate-limit.sql`, the 42nd file. Idempotent, every
object created if missing or replaced, safe to re-run in order (trap 25;
it replaces nothing from an earlier file).

```sql
-- rate_windows: ONE row per (tenant, key, window). No policy for any token
-- (Rule 2): only rate_allow() reads and writes it.
create table if not exists public.rate_windows (
  tenant_id    bigint      not null references public.tenants (id) on delete cascade,
  key          text        not null,           -- 'chat|<tenant>|<ip>', 'voice-in|…', 'manage|…', '<tenant>|<ip>'
  window_start timestamptz not null,
  count        int         not null default 1,
  primary key (tenant_id, key, window_start),
  constraint rate_windows_key check (length(key) <= 200)
);
alter table public.rate_windows enable row level security;
revoke all on public.rate_windows from anon, authenticated;

-- rate_allow(): bump this key's window and say whether the call is inside the
-- limit. ONE statement (Rule 1). Refuses another tenant's id (Rule 2). Sweeps
-- the key's old windows (§ 2.3). security definer, search_path = '' (§ 2.2).
create or replace function public.rate_allow(p_tenant_id bigint, p_key text, p_max int, p_window_seconds int)
returns boolean … security definer set search_path = '' …
--   if p_tenant_id is distinct from public.app_tenant_id() → insufficient_privilege
--   delete from public.rate_windows where tenant_id = p_tenant_id and key = p_key
--     and window_start < now() - make_interval(secs => 2 * p_window_seconds);
--   insert … values (p_tenant_id, p_key, date_bin(make_interval(secs => p_window_seconds), now(), '2000-01-01'), 1)
--     on conflict (tenant_id, key, window_start) do update set count = rate_windows.count + 1
--     returning count into v_count;
--   return v_count <= p_max;
```

The thirteenth callable definer function: CLAUDE.md rule 8's list grows by
one.

---

## 4. The limiter and its callers

`apps/web/lib/rate-limit.ts`:

- `WINDOW_MS` becomes `WINDOW_SECONDS = 600`; `MAX_REQUESTS_PER_WINDOW`
  stays 10; `CHAT_REQUESTS_PER_WINDOW` is new, a policy number (§ 7 q1).
- `allow(tenant: TenantContext, key: string, max = MAX_REQUESTS_PER_WINDOW):
  Promise<boolean>` calls `tenant.db.rpc('rate_allow', { p_tenant_id:
  tenant.id, p_key: key, p_max: max, p_window_seconds: WINDOW_SECONDS })`,
  throws on `error`, returns `data === true`.
- `clientIp()` is unchanged. The `Map` and the `now` parameter go.
- The file's comment says what changed and why: the count is Postgres's,
  so it is the same on every instance (R-39 closed), and it is the only
  limit on the chat and voice routes, so it is no longer "the weak one".

The seven callers (`book/request`, `manage`, `manage/change`,
`manage/change/withdraw`, `manage/proof`, `voice/transcribe`,
`voice/speak`): `await allow(tenant, …)`, the key and the words as they
are. `chat/route.ts` gains the eighth, with its own sentence.

The per-tenant ceiling (§ 7 q2, if taken): the chat and voice routes make a
second call, `allow(tenant, 'chat|<tenant>|*', CHAT_TENANT_CEILING)`, after
the per-IP one; the same 429 sentence. Two round trips on those routes;
one on the rest.

Tests (`apps/web/lib/rate-limit.test.ts`, new): a fake `tenant.db.rpc`
records its arguments (the tenant id, the key, the max, 600); `true` →
true, `false` → false, an `error` → throws; `clientIp()`'s three cases.
The chat screen's 429 path: a response with status 429 and `{ error }`
shows those words.

---

## 5. Phases

### Phase 0 — Baseline
On `feat/rate-limit` from `master`: web tests, typecheck 13/13, verify 224,
rooms 56, the three baselines diffed. Pipeline and bookings isolation
cannot run (northwind and harbor are gone, 2026-10-20); recorded as such.
The battery is not run (Rule 6).

### Phase 1 — SQL
`schema-rate-limit.sql`, applied by Claude on `DATABASE_URL`. verify gains
225–229: (225) a villa chat token's 10 calls on one key return true and
the 11th false, and the service client sees ONE row with `count = 11`;
(226) a token of another tenant calling with villa's id gets
`insufficient_privilege`; (227) a chat token selects `rate_windows` and
gets no row while the service client sees it (§ 2.5); (228) a row aged two
windows (set by the service client) is gone after the next call on that
key, and that call is true; (229) two keys do not share a count.

### Phase 2 — The limiter and the seven callers
`allow()` over `rate_allow()`; the seven `await`s; the tests; typecheck
(the signature change finds every caller). `plan/voice-phase2-walk.mjs`
step 6 sends a fresh address (§ 2.1).

### Phase 3 — The chat
`chat/route.ts`'s window before the Accept check (Rule 5), its sentence;
the per-tenant ceiling on chat and voice if q2 is yes; `chat-screen.tsx`
reads the 429's words (§ 2.6); tests.

### Phase 4 — The walls and the walk
verify 229, rooms 56, web tests, typecheck, the three baselines
byte-identical. `plan/rate-limit-walk.mjs` over HTTP against `pnpm dev`,
a random `X-Forwarded-For` per run: (1) N chats then a 429 with the
sentence, and no `[openai]` line after it; (2) the same count of rows in
`rate_windows` as calls sent, on the service client, which is the proof
the count is not in memory; (3) 10 booking requests then 429, unchanged
words; (4) 10 Manage lookups then 429; (5) voice, where on, 30 then 429;
(6) a second address on the same tenant is fresh; (7) the ceiling, if
taken: a tenant whose addresses together pass it gets 429 on a new one. A
browser step: the 11th… question's refusal drawn in the turn, in the
tenant's colours, axe clean. The user walks the chat on alteza with the
screen open.

### Phase 5 — The record
D-137 (the shared count, the chat's limit, the ceiling if taken, the
numbers as policy); R-39 **closed**; R-13 amended (the open chat is
limited; the audit log stays owed); R-53 amended (the rotating-address
sentence); CLAUDE.md (the header, 42 sql files, rule 8's thirteenth
callable definer, verify 229, the "weak limit" lines in the layout and
conventions); flow.md's request-limits lines; status, whats-done.

---

## 6. What must not change

- `request_booking()`'s per-contact cap and `guest_stay()`'s lockout: the
  SQL limits that hold whoever calls, now beside a shared per-IP one.
- `clientIp()`: the first `X-Forwarded-For` entry, Vercel's; `local` with
  none.
- Every 429 sentence the seven routes say today.
- The chatbot, the prompts, the tools, the three baselines (Rule 6).
- No `service_role` in a request; no new policy on `rate_windows` for any
  token (Rule 2).

---

## 7. Questions, each with a recommendation

1. **The chat's number.** A visitor types at most one question every
   fifteen or twenty seconds; thirty in ten minutes is one every twenty.
   **Recommend 30 per IP per tenant per 10 minutes**, the voice routes'
   figure, recorded as policy, not a measurement, and changed in one
   constant.
2. **A per-tenant ceiling across addresses?** R-53's gap: a caller
   rotating addresses passes any per-IP limit. A second key per tenant,
   `chat|<tenant>|*`, with a far larger max (say 600 per 10 minutes, one a
   second, more than a small resort's visitors send together) caps the
   OpenAI bill a stranger can run up, at the cost of one more round trip
   on the two OpenAI routes and the chance that a genuinely busy tenant is
   refused for a few minutes. **Recommend yes**, on the chat and voice
   routes only, with the figure in a constant beside the chat's.
3. **`book/quote` and the room-list reads too?** They read the database
   and call no model; the cost of a thousand quotes is Postgres time.
   **Recommend no**: the limit is where money is spent, and a limit on the
   quote would refuse a guest comparing dates.
4. **Fail open when Postgres is unreachable?** **Recommend no** (Rule 4):
   the route fails a line later anyway, and an opened limit under strain
   is the worst moment to have one.
5. **Branch timing.** Nine files are modified and uncommitted on `master`
   (the guest-links walk and the nav). **Recommend** committing or
   stashing them first, then `feat/rate-limit` from a clean `master`, so
   the diff is this plan alone.
