# `web`

The Next.js app. **Phase 5 built the six API routes; the two screens are
Phase 6** — `app/page.tsx` is a placeholder until then, and the POC's own pages
still work from `apps/legacy-poc`.

```sh
pnpm --filter web dev      # http://localhost:3000
pnpm --filter web build
pnpm --filter web start
```

## The routes

Every route is under a tenant: `/api/t/<slug>/…` (tenancy Phase 5, D-026). The
old un-prefixed paths are gone. `/api/chat` is a 404, on purpose, and nothing
redirects or picks a tenant for you.

| Route | Replaces |
|---|---|
| `POST /api/t/<slug>/documents` · `GET /api/t/<slug>/documents` | `server.js` lines 78–105 |
| `DELETE /api/t/<slug>/documents/[id]` | 107–117 |
| `GET /api/t/<slug>/documents/[id]/chunks` | 119–130 |
| `POST /api/t/<slug>/chat` | 132–213 — JSON **and** SSE |
| `GET /api/t/<slug>/conversations/[id]/messages` | 215–217 |

An unknown slug is a `404` with `{"error":"No workspace named \"<slug>\""}`.
Another tenant's document or conversation id behaves exactly like one that does
not exist: `[]` for chunks, `404` for a delete or a transcript. That is
deliberate, so ids cannot be enumerated across tenants.

```sh
curl localhost:3000/api/t/northwind/documents
curl -X POST localhost:3000/api/t/northwind/chat -H 'content-type: application/json' \
  -d '{"message":"What temperature does the Bay 3 freezer run at?"}'
curl -N -X POST localhost:3000/api/t/villa/chat -H 'content-type: application/json' \
  -H 'accept: text/event-stream' -d '{"message":"What is the Wi-Fi password?"}'
```

To add a document, `POST` `{"title", "source"?, "content"}` to
`/api/t/<slug>/documents`. Don't do it casually against `northwind` or `villa`:
they are the fixtures the eval battery asserts against, and an extra document
changes its verdicts.

All are `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`. Not edge: the
pipeline uses supabase-js and holds a connection open while the model writes.

## Three things that are easy to get wrong here

**1. Every handler must be wrapped in `withTenantRoute`** (`lib/tenant.ts`),
which resolves the slug, 404s on a miss, and is built on `withRoute`. The
reason is the same as for `withRoute` below.

**Under it, `withRoute`.** Express called its error
middleware for any route that threw, so the mapping could not be forgotten.
Route Handlers have no equivalent — one unwrapped handler and that route
answers with Next's generic 500 instead of the real reason. The map itself is
unchanged: 401 and 429 pass through from OpenAI, ≥500 becomes 502, everything
else 500, and the real message always reaches the client (architecture.md § 9).

**2. The `Accept` check is deliberately explicit.** `Accept: text/event-stream`
streams; anything else gets the original single JSON body (D-019). It is a
string check rather than content negotiation because curl sends `Accept: */*`,
which a negotiation helper happily matches against `text/event-stream` — and
then every curl is handed a stream it cannot parse. The POC hit this exact bug.

**3. A streaming failure cannot use a status code.** The headers went out with
the 200, so `withRoute` cannot help. The failure travels down the stream as an
`error` event instead, and a client that ignores those events will show a
half-answer as if it were whole.

## Environment

`next.config.mjs` loads the repo-root `.env`, because that is where the POC,
the eval tools and the db verification script all read from. Copying the
secrets into `apps/web` would mean two files holding the same API key, free to
drift, and two places to revoke when one leaks. In production, env comes from
the platform and the loader finds nothing, which is correct.

The check for missing variables runs at import — one line in the log — and
throws per request, so the real message reaches the client instead of a generic
500 page. `lib/env.ts` explains why it is not a module-scope throw.

`lib/limits.ts` is separate from `lib/env.ts` because the admin page needs
`MAX_CONTENT_LENGTH` in the browser, and importing anything from a
`server-only` module fails the build.
