# Screens — RAG Chatbot POC

> ### ⚠ The states are current; two routes are not
>
> Rebuilt in React 2026-09-22 (D-021). Every state below is still the spec and
> still implemented. The knowledge base is now `/admin` rather than
> `/admin.html`, and both screens are `apps/web/app/`.

Every page in the product, what is on it, and what it does in each state.

**A note on roles.** The POC has no authentication (`mvp.md` § Out of scope), so
there is no technical role separation — anyone who can reach `localhost:3000`
can reach both pages. The two "roles" below are *hats the same person wears*,
and the screens are split along that line because the tasks are genuinely
different: curating the knowledge base is a separate activity from using it.
Keeping them apart now is what makes adding real auth later a routing change
rather than a rewrite.

Total: **2 screens.** That is the right number for this project.

---

## Role: Chat user ("the person asking questions")

### S-1 · Chat

| | |
|---|---|
| **Route** | `GET /` → `public/index.html` |
| **Who** | Anyone using the bot — in the POC, you, testing it |
| **Purpose** | Ask questions and see answers grounded in the knowledge base |
| **Entry** | Open `http://localhost:3000` |

**What's on it**

```
┌──────────────────────────────────────────────────┐
│  RAG Chatbot POC              [ Knowledge base ] │  ← header + link to S-2
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌────────────────────────────────┐              │
│  │ What is the refund window?     │  ← user msg  │
│  └────────────────────────────────┘   (right)    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ Refunds are accepted within 30 days of   │    │
│  │ delivery, provided the item is unopened. │    │  ← assistant
│  └──────────────────────────────────────────┘      (left)
│    ▸ 2 sources                                   │  ← collapsed by default
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ ▾ 2 sources                              │    │  ← expanded
│  │  ┌────────────────────────────────────┐  │    │
│  │  │ Returns Policy · 0.83               │  │    │  ← title · similarity
│  │  │ "Refunds are accepted within 30…"  │  │    │  ← chunk text, truncated
│  │  └────────────────────────────────────┘  │    │
│  │  ┌────────────────────────────────────┐  │    │
│  │  │ Shipping FAQ · 0.61                 │  │    │
│  │  │ "Items sent back must include…"    │  │    │
│  │  └────────────────────────────────────┘  │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
├──────────────────────────────────────────────────┤
│ [ Ask a question…                    ] [ Send ]  │  ← input, autofocus
└──────────────────────────────────────────────────┘
```

**What you can do**

| Action | Result |
|---|---|
| Type + press Enter (or click Send) | `POST /api/chat` with `{ conversationId, message }` |
| Shift+Enter | Newline, does not send |
| Click "▸ N sources" | Expands the sources panel for that answer |
| Click a source chunk | Expands it from truncated to full text |
| Click "Knowledge base" | Navigates to S-2 |
| Click "New chat" | Clears `conversationId` and the message list |

**The sources panel is a required feature, not a debug aid.** It is the only way
to see whether an answer came from your documents or from the model's training
data — which is the entire question this project exists to answer. It stays
visible in the finished POC.

**States**

| State | Shown |
|---|---|
| **Empty** (no messages yet) | Centred hint: "Ask a question about your documents." Plus, if `GET /api/documents` returns `[]`: "Your knowledge base is empty — **add a document first**" linking to S-2. |
| **Loading** | User message appears immediately; an assistant bubble shows an animated "…" ; input disabled; Send shows a spinner. |
| **Success** | Assistant bubble with the answer, collapsed sources beneath. Scrolls to bottom. |
| **No relevant context** | Normal assistant bubble reading "I don't know based on the documents I have." Sources panel reads "No matching chunks above the similarity threshold." **This is a success state, not an error** — it is the system working correctly. |
| **Error — OpenAI 429 / no credits** | Red inline notice: "OpenAI request failed: out of credits or rate limited." The user message stays in the list with a **Retry** button. |
| **Error — OpenAI 401** | "OpenAI rejected the API key — check `.env`." |
| **Error — server unreachable** | "Cannot reach the server. Is `pnpm dev` running?" |
| **Error — Supabase** | "Database error: `<message>`." |
| **Offline** | The server-unreachable state. No offline support; nothing is cached. |
| **Permission denied** | **Does not exist.** No auth in the POC. |

---

## Role: Knowledge base owner ("the person curating what the bot knows")

### S-2 · Knowledge base

| | |
|---|---|
| **Route** | `GET /admin` → `apps/web/app/admin/page.tsx` |
| **Who** | You, managing what the bot can answer from |
| **Purpose** | Add, inspect and delete documents; see how they were chunked |
| **Entry** | The header link on S-1, or direct URL |

**What's on it**

```
┌──────────────────────────────────────────────────┐
│  Knowledge base                      [ ← Chat ]  │
├──────────────────────────────────────────────────┤
│  Add a document                                  │
│  Title   [ Returns Policy                      ] │  ← required
│  Source  [ handbook p.12          ] (optional)   │
│  Content ┌────────────────────────────────────┐  │
│          │ Paste the document text here…      │  │  ← required, large
│          │                                    │  │
│          └────────────────────────────────────┘  │
│          1,204 characters · ≈ 2 chunks           │  ← live estimate
│                              [ Add to knowledge ]│
├──────────────────────────────────────────────────┤
│  Documents (3)                                   │
│  ┌────────────────────────────────────────────┐  │
│  │ Returns Policy      2 chunks  2026-09-20 🗑 │  │
│  │ Shipping FAQ        5 chunks  2026-09-20 🗑 │  │
│  │ Product Specs      11 chunks  2026-09-19 🗑 │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**What you can do**

| Action | Result |
|---|---|
| Fill the form + Add | `POST /api/documents` → chunk, embed, store |
| Watch the chunk estimate | Live `Math.ceil` from the chunker's constants — makes chunking visible *before* you commit |
| Click 🗑 | Confirm dialog, then `DELETE /api/documents/:id` (chunks cascade) |
| Click a document row | Expands to show its chunks, each with index and first ~200 characters |
| Click "← Chat" | Back to S-1 |

**Expanding a row to see the actual chunks is worth building.** Seeing your text
sliced up — and seeing the overlap repeat across the boundary — is what makes
chunking concrete rather than theoretical.

**States**

| State | Shown |
|---|---|
| **Empty** (no documents) | "No documents yet. Paste something above to give the bot something to know." |
| **Loading list** | "Loading documents…" |
| **Submitting** | Button → "Embedding… (this may take a few seconds)"; form disabled. Genuinely slow for long documents — the OpenAI call is synchronous. |
| **Success** | Green notice: "Added *Returns Policy* — 2 chunks embedded." Form clears, list refreshes. |
| **Validation error** | Inline: empty title, empty content, or content over ~100,000 characters. Client-side *and* server-side. |
| **Error — embedding failed** | Red: "Embedding failed: `<message>`." ⚠️ **See the note below.** |
| **Error — delete failed** | Red: "Could not delete: `<message>`." Row stays. |
| **Offline** | "Cannot reach the server." |
| **Permission denied** | **Does not exist.** No auth in the POC. |

> ⚠️ **Partial-ingest failure.** If the embedding call fails *after* the
> `documents` row is inserted, you get a document with zero chunks — it appears
> in the list but can never be retrieved. The MVP handles this the simple way:
> **delete the `documents` row in a `catch` block before rethrowing.** Not a
> transaction, just cleanup. The list also shows a "⚠ 0 chunks" badge so an
> orphan is visible if one slips through.

---

## Route map

| Route | Method | Screen / purpose | Role |
|---|---|---|---|
| `/` | GET | S-1 Chat | Chat user |
| `/admin.html` | GET | S-2 Knowledge base | KB owner |
| `/api/chat` | POST | Ask a question | S-1 |
| `/api/conversations/:id/messages` | GET | Load history | S-1 |
| `/api/documents` | POST | Ingest a document | S-2 |
| `/api/documents` | GET | List documents | S-1 (empty check), S-2 |
| `/api/documents/:id` | DELETE | Remove a document | S-2 |

## Role-visibility matrix

| Screen | Chat user | KB owner | Enforced by |
|---|---|---|---|
| S-1 Chat | ✅ | ✅ | — |
| S-2 Knowledge base | ✅ *(reachable)* | ✅ | **Nothing.** No auth in the POC |

The matrix is honest rather than aspirational: today both hats see everything.
When auth arrives post-MVP, S-2 is the screen that goes behind it, and the
`/api/documents` write routes are what need guarding — the split above already
puts the right things on the right side of that line.

## Deliberately NOT screens in the MVP

| Not built | Why |
|---|---|
| Login / signup / password reset | No auth (`mvp.md`) |
| Conversation history sidebar | Conversations persist in the database but are not listed. One session at a time is enough to test with. |
| Settings page (chunk size, model, threshold) | These are constants in the source. Editing the code to change them is *more* instructive, not less. |
| Document editor | Delete and re-add. Editing means re-chunking and re-embedding — real work, no learning. |
| Usage / cost dashboard | OpenAI's own usage page already exists. |
| Search-the-knowledge-base page (no chat) | Tempting and genuinely useful for debugging — but the sources panel on S-1 already shows retrieval results, so it would be a second view of the same data. |
| 404 page | Express default is fine. |
