# Sample documents — Villa Amihan Private Resort

Eight documents making up one coherent knowledge base for testing the RAG
pipeline. Paste each one into the admin page (S-2) as a separate document, using
the file's title as the document title.

**This README is not part of the knowledge base — do not ingest it**, and
neither is `TEST-PROMPTS.md`. Ingesting either would put an index of the corpus
into the corpus, which retrieves well and answers nothing.

To check the bot against this corpus, work through
[`TEST-PROMPTS.md`](./TEST-PROMPTS.md) — 29 prompts with expected answers,
the documents each should cite, and what counts as a fail.

| File | Covers |
|---|---|
| `01-resort-overview.md` | What and where the resort is, capacity, hot spring water, contact |
| `02-rates-and-schedules.md` | The three booking slots, rates, holiday and peak surcharges, inclusions |
| `03-amenities-and-facilities.md` | Pools, the four bedrooms, bathrooms, kitchen, grilling area, Wi-Fi, parking |
| `04-booking-and-payment.md` | How to book, reservation fee, balance, deposit, cancellation |
| `05-house-rules.md` | Noise curfew, guest count, food, pool rules, pets, smoking, checkout |
| `06-directions-and-getting-there.md` | Driving and public transport routes, nearby places, arrival |
| `07-events-and-add-ons.md` | What the resort is used for, paid add-ons, what is not available |
| `08-faq.md` | The same facts as short question-and-answer pairs |

## The content is invented

Villa Amihan is not a real resort. Every name, rate, phone number, account
number and ordinance in these files is made up. That is deliberate: the
definition of done in `mvp.md` needs facts the model **cannot** already know, and
an invented corpus guarantees that. Replace the details with the real ones when
this stops being a POC.

## Facts to test retrieval with

These are specific enough that a correct answer can only have come from
retrieval, not from the model's training data:

- The Wi-Fi password is `amihanpansol2019` (`03`).
- The septic system, not floor space, is what caps the property at 45 guests (`01`, `05`).
- A pool refill takes about four hours, which is why early check-in is refused (`03`, `08`).
- The peak surcharge on 24, 25 and 31 December is ₱4,000 on top of the holiday rate (`02`).
- Barangay Bagong Kalsada Ordinance 2018-04 is what ends videoke at 10:00 PM (`05`).
- Tricycle drivers know Sampaguita Lane by its old name, Purok 4 Extension (`06`).

## Facts deliberately absent

Ask these to check that the bot refuses instead of inventing. Nothing in the
corpus answers them:

- Is there a jacuzzi or a sauna?
- Can we fly a drone over the property?
- Does the resort have a generator for brownouts?
- What are the rates for 2027?
- Is there a discount for senior citizens or PWDs?

## Cross-document questions

These need chunks from two or more documents, which is what tests `MATCH_COUNT`
rather than just similarity:

- "We're 38 people staying overnight on a Saturday in December — what do we pay?"
  (`02` rates + excess head charge, `05` hard cap)
- "We're arriving by coaster at 7 AM for a day tour — what happens?"
  (`06` the lane is too narrow, `03`/`08` no early entry during the refill)
- "Can we hire someone to cook and watch the kids by the pool?"
  (`07` a cook is ₱1,500, no lifeguard at any price)
