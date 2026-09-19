# Idea Intake — RAG Chatbot POC

> Raw capture. Answers came from a short Q&A session; anything the user did not
> state is marked **[assumed]** and was decided during planning — see
> `decisions.md`.
>
> Date captured: 2026-09-20

---

## 1. The idea in one line

A deliberately small, from-scratch chatbot that answers questions from **my own
knowledge base** — built with native HTML, native JavaScript, Node/Express and
OpenAI, so that I understand every moving part of a RAG system.

## 2. The problem

- **What problem does this solve?** Not a market problem — a *knowledge* problem.
  RAG chatbots are normally assembled from frameworks (LangChain, LlamaIndex,
  Vercel AI SDK, Supabase's `ai` helpers) that hide the actual mechanism:
  chunking, embedding, vector search, prompt assembly. You can ship one without
  knowing what any of it does.
- **Whose problem is it?** Mine. I want to be able to reason about, debug and
  cost-estimate a RAG system, not just wire one together.
- **How is it handled today?** Copy a starter template, change the API key, hope
  nothing breaks.
- **Why is it worth solving?** Every "AI feature" request at work or in a side
  project is some variant of this pipeline. Understanding it once transfers
  everywhere.

## 3. Who it's for

- **Target user:** me, the builder. Secondary: any future project that needs a
  reference implementation of RAG with no framework in the way.
- **What they use instead:** framework tutorials and hosted "chat with your docs"
  products.
- **Would I use it?** Yes — as a reference implementation and as a base to fork.

## 4. What it does (the core)

- Paste a document into an admin page. The server splits it into chunks, gets an
  embedding for each chunk from OpenAI, and stores the chunks + vectors in
  Supabase Postgres (pgvector).
- Ask a question in a chat page. The server embeds the question, finds the most
  similar chunks by vector distance, pastes them into the prompt as context, and
  asks OpenAI to answer **using only that context**.
- **The core action / "aha" moment:** asking something that is *only* in your
  pasted document and getting a correct answer, with the source chunks shown
  next to it — proof the model is reading your data, not its training set.
- **Success for the user:** being able to point at any line of the pipeline and
  explain what it does and why.

## 5. Must-haves vs nice-to-haves

**Cannot launch without:**
1. Add a document to the knowledge base (paste text).
2. Automatic chunking + embedding + storage in Supabase.
3. Vector similarity search over the chunks.
4. A chat endpoint that answers grounded in retrieved chunks.
5. A plain HTML chat UI that shows which chunks were used.

**Nice but can wait:** file upload (PDF/MD), streaming responses, conversation
memory beyond a single session, re-ranking, hybrid keyword+vector search,
chunk-level citations inline in the answer.

**Explicitly not doing:** user accounts, multi-tenancy, deployment/hosting,
any frontend framework, any RAG framework, any build step.

## 6. The MVP

- **Smallest useful version:** one Express server, two static HTML pages
  (chat + admin), four API routes, two database tables, running on
  `localhost:3000`.
- **Success signal:** paste a document containing a fact the model cannot know
  (e.g. an internal policy, a made-up product spec). Ask about it. Get the right
  answer plus the chunk it came from. Then delete the document and ask again —
  the bot should say it doesn't know.

## 7. Tech direction

- **Platform:** web, local only.
- **Tech to use:** native HTML (no framework), native browser JavaScript (no
  bundler, no npm frontend), Node.js + Express for the backend, Supabase
  Postgres as the database, OpenAI for embeddings and chat.
- **Tech to avoid:** React/Vue/Svelte, TypeScript **[assumed]**, LangChain or any
  RAG framework, any build tooling, Docker **[assumed]**.
- **External services:** OpenAI API (paid, prepaid credits), Supabase (free tier).
- **Auth / storage / AI:** no auth in the POC **[assumed]**. Storage is Supabase
  Postgres with the `pgvector` extension. AI is OpenAI embeddings + chat
  completions, called over plain HTTPS.

## 8. Constraints & reality check

- **Budget:** near zero. Supabase free tier; OpenAI prepaid credits — the $5
  minimum top-up is expected to last the whole POC many times over.
- **Time:** a few evenings **[assumed]**.
- **Solo or with others:** solo.
- **Hard constraints:** must run entirely on `localhost`; must stay readable
  end-to-end; no dependency may hide a step of the pipeline.

## 9. Risks & unknowns

- Biggest killer: none, really — the pipeline is well-trodden. The realistic
  failure is **scope creep** turning a learning exercise into a product.
- To validate: that a naive fixed-size chunker retrieves well enough on real
  documents (it usually does for small corpora).
- Unsure about: how chunk size and `match_count` affect answer quality — which
  is exactly the thing the POC exists to teach.

## 10. Why you, why now

- Good fit: already comfortable with Node, Express and Supabase from other
  planned projects in this folder.
- Why now: the surrounding ideas (`customer-rewards-platform`,
  `shared-auth-layer`) will eventually want an assistant feature. Learning the
  mechanism on a throwaway POC is cheaper than learning it inside a real product.
- **Motivation: learning project.** Explicitly stated. This is the whole point.

## 11. Anything else

The stated purpose — *"I want to fully understand how it works"* — is the
project's primary requirement, not a footnote. Any decision that makes the code
shorter but the mechanism more opaque is the wrong decision here.
