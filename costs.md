# Costs — RAG Chatbot POC

> ⚠️ **Prices below were written on 2026-09-20 from documentation and are the
> least durable content in this folder.** Verify at
> <https://platform.openai.com/docs/pricing> before relying on any figure. The
> *structure* of the cost model — what you pay for and when — is stable; the
> per-token numbers are not.

## Short answer

**One paid thing: OpenAI API credits. Minimum top-up is typically $5, and for a
POC of this size that $5 will not run out.**

Everything else — Supabase, Node, Express, the browser, running it locally — is
free at this scale.

---

## What you pay for

| Service | Plan | Cost |
|---|---|---|
| **OpenAI API** | Prepaid credits (pay-as-you-go) | **$5 minimum top-up.** Actual usage for this POC: well under $1 |
| **Supabase** | Free tier | **$0** |
| Node.js, Express, `pgvector`, `@supabase/supabase-js` | Open source | $0 |
| Hosting | None — localhost only (D-013) | $0 |
| Domain, SSL, CI | Not applicable | $0 |

### The ChatGPT Plus trap

**A ChatGPT Plus / Pro subscription does not include API access.** They are
separate products with separate billing. Paying $20/month for ChatGPT gives you
zero API credits, and an API key created under that account still fails with a
quota error until you add credits.

What you need: an account on **platform.openai.com**, Billing → add a payment
method → add credits. That is it. There is no subscription to cancel afterwards.

### Supabase free tier

Comfortably sufficient here. The free tier's relevant limits are ~500 MB of
database storage and a pause after ~1 week of inactivity (one click to restore).
A few dozen documents' worth of chunks and embeddings is a few megabytes.

One thing worth knowing: each 1536-dimension embedding is roughly **6 KB** on
disk (1536 × 4 bytes, plus overhead). Ten thousand chunks ≈ 60 MB — still fine,
but it explains why embeddings dominate the storage of a RAG system rather than
the text.

---

## OpenAI cost model — how it actually works

Two separate meters, billed per **token** (~4 characters of English):

### 1. Embeddings — `text-embedding-3-small`

Charged on input only, at roughly **$0.02 per 1 million tokens**.

You pay here **twice**:

- **Once per document, at ingest.** Permanent; the vectors are then stored.
- **Once per question asked.** The question must be embedded to be searched
  with. A question is ~20 tokens, so this is effectively free.

A 50-page document is around 25,000 tokens → **about $0.0005**. Half a tenth of
a cent. You could ingest a small library for the price of a coffee.

### 2. Chat — `gpt-4o-mini`

Charged separately for input and output, with output several times more
expensive. Order-of-magnitude figures at time of writing: roughly **$0.15 per 1M
input tokens** and **$0.60 per 1M output tokens**.

Per question, the input is not just the question. It is:

| Part | Rough size |
|---|---|
| System prompt + instructions | ~100 tokens |
| 5 retrieved chunks × ~1000 chars | ~1,250 tokens |
| Up to 6 messages of history | ~600 tokens |
| The question itself | ~20 tokens |
| **Total input** | **~2,000 tokens** |
| Output (a paragraph) | ~150 tokens |

That works out to roughly **$0.0004 per message** — about **2,500 questions per
dollar**.

### Realistic total for the whole project

| Activity | Estimate |
|---|---|
| Ingesting 20 test documents, several times over while tuning | < $0.05 |
| 500 test questions across the whole build | ~$0.20 |
| Phase 5 experiments (re-ingesting at different chunk sizes) | < $0.10 |
| **Total** | **well under $1 of the $5 minimum** |

The leftover credit stays on the account for the next project.

---

## What would actually make this expensive

Useful to know, because these are the levers that matter in a real system:

| Lever | Effect |
|---|---|
| **Uncapped conversation history** | The whole conversation is re-sent every turn. A 50-turn chat re-uploads 49 turns on turn 50. Cost grows with the *square* of conversation length. This is why D-011 caps it at 6. |
| **Large `match_count` × large chunks** | `match_count: 20` at 4000 chars each is ~20,000 input tokens per question — 10× the baseline, for answers that are usually no better. |
| **Switching to a frontier chat model** | Often 20–50× the per-token price of a mini model, for a task ("read this context and answer") where the mini model is already sufficient. |
| **Re-embedding on every query instead of caching** | Not a real risk here — embeddings are stored once — but a common mistake worth naming. |
| **A runaway loop in dev** | The genuine risk. A retry loop or an accidental `while` around an API call can burn credits fast. |

## Cost safety while learning

1. **Set a usage limit** in OpenAI Billing → Limits. Pick something like $5 with
   an email alert at $2. Do this in Phase 0, before writing any code.
2. **Never put a retry loop around an OpenAI call in the MVP** (`architecture.md`
   § 9 rules this out explicitly).
3. **Check usage after Phase 5** — comparing the real number against the
   estimates above is itself part of the learning, and it recalibrates your
   instinct for what LLM features cost.

## Time cost

Roughly **8–10 hours** — see `mvp.md` § Time estimate. That is the real budget
for this project; the money is a rounding error.
