# Tech Stack — RAG Chatbot POC

The stack is chosen for **transparency, not productivity**. The purpose of the
project is to understand the mechanism, so every layer is either something you
write yourself or something whose behaviour you can read in one sitting.

**The rule:** no dependency may hide a step of the RAG pipeline. If a library
would do the chunking, the embedding call, the vector search or the prompt
assembly *for* you, it is disqualified — that is the part you are here to learn.

## Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Language | **JavaScript (ES modules), no TypeScript** | One less compile step between you and the running code. `"type": "module"` in `package.json` so `import` works natively. |
| Runtime | **Node.js 20 LTS or newer** | Required: Node 18+ ships a global `fetch`, so calling OpenAI needs no HTTP library at all. Node 20 is the safe floor. |
| Backend | **Express 4** | Explicitly requested. Routing and JSON body parsing, nothing else. Express 5 is out but 4 is what every tutorial and answer you will read matches — see D-009. |
| Frontend | **Native HTML + native browser JS** | Explicitly requested. No framework, no bundler, no npm packages in the browser, no build step. Served as static files by Express. |
| Database | **Supabase Postgres** | Explicitly requested. Free tier, hosted, and the `pgvector` extension is available on it — which is the whole reason it works for this. |
| Vector storage | **`pgvector` (`vector` column type)** | Keeps embeddings in the same database as the text. No second system (Pinecone/Weaviate/Chroma) to run or reason about. |
| DB access | **`@supabase/supabase-js` v2** | Talks to Supabase over HTTPS/PostgREST — no connection strings, no pooler config, works from a laptop behind any network. Used for plain CRUD and to call one SQL function via `.rpc()`. |
| Embeddings | **OpenAI `text-embedding-3-small` (1536 dims)** | The cheapest current OpenAI embedding model and more than good enough for a small corpus. 1536 dimensions fits inside pgvector's indexable limit with no tricks. |
| Chat model | **OpenAI `gpt-4o-mini`** (env-configurable) | Cheap, fast, fully capable of "answer from this context". Set via `OPENAI_CHAT_MODEL` so swapping models is a config change, not a code change — verify the current model list and prices at <https://platform.openai.com/docs/models> before building. |
| OpenAI client | **Native `fetch` — no `openai` SDK** | Deliberate. Writing the `POST https://api.openai.com/v1/embeddings` call by hand is ~10 lines and shows you exactly what goes over the wire. The SDK would hide the request body, which is the thing worth seeing. |
| Config | **`dotenv` + a `.env` file** | Keeps the OpenAI key and Supabase keys out of the source. |
| Dev loop | **`node --watch server.js`** | Built into Node 20. No nodemon. |
| Tests | **None in the MVP** | A POC whose success criterion is "I understand it". Manual verification against the checklist in `mvp.md` instead. Revisit if it graduates. |

## Total dependency list

```jsonc
// package.json
{
  "type": "module",
  "dependencies": {
    "express": "^4",
    "@supabase/supabase-js": "^2",
    "dotenv": "^16"
  }
}
```

**Three dependencies. Zero frontend dependencies. Zero build tooling.**

If this list grows during the build, stop and ask what step of the pipeline the
new package is taking over from you.

## Deliberately avoided

- **LangChain / LlamaIndex / Vercel AI SDK** — they exist precisely to hide the
  pipeline this project is built to expose. Using one would make the project
  pointless.
- **The `openai` npm SDK** — convenient, but it turns the two most instructive
  HTTP calls in the project into method calls. Use `fetch`.
- **Supabase's `supabase.ai` / built-in embedding helpers** — same reason.
- **React / Vue / Svelte / htmx** — the UI is a text box, a message list and a
  form. Native DOM is genuinely less code here.
- **TypeScript** — adds a compile step to a project whose whole point is
  reading the running code.
- **A separate vector database** (Pinecone, Chroma, Qdrant, Weaviate) — a second
  service to run, and it would split the text and its embedding across two
  systems for no benefit at this size.
- **Docker** — `node server.js` is the dev loop. Nothing to containerise.
- **Deployment** — the POC is local-only by design (`mvp.md` § Out of scope).

## Hard constraints

1. **Runs entirely on `localhost`.** No hosting, no domain, no HTTPS setup.
2. **The OpenAI API key never reaches the browser.** All OpenAI calls happen in
   Express. This is the one security rule the POC does enforce — see
   `risks.md` § R-1.
3. **The Supabase `service_role` key never reaches the browser either.** The
   browser talks only to your own Express server.
4. **No step of the pipeline may be opaque.** If you cannot explain what a line
   does, it does not go in.

## Versions to pin at Phase 0

Record the actual installed versions here once `npm install` has run, so a
future reader knows what the code was written against:

| Package | Planned | Actually installed |
|---|---|---|
| node | ≥ 20 LTS | **24.19.0** |
| express | ^4 | **4.22.3** |
| @supabase/supabase-js | ^2 | **2.116.0** |
| dotenv | ^16 | **16.6.1** |
| OpenAI embedding model | `text-embedding-3-small` | **`text-embedding-3-small`** — confirmed not deprecated on OpenAI's deprecations page, 2026-09-20 |
| OpenAI chat model | `gpt-4o-mini` | **`gpt-4o-mini`** — not scheduled for shutdown; revisit in Phase 5 (D-005) |
