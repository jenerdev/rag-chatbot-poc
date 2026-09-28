# Villa prices plan: one source of truth, the database

> Villa's rates lived in two places after customer booking: `unit_rates`
> (what the page and the trigger use) and `02-rates-and-schedules.md` (what
> the chat answered from), and nothing detected drift (R-41, accepted). This
> makes the database the only source: villa's `check_availability` carries
> the price for a date, as harbor's has since booking types, and the figures
> the database holds leave the documents. The rules stay in prose.
>
> Written 2026-09-28, against `73586a3` on `master`. **Status: complete, 2026-09-28;** D-074, R-41 and R-17 closed. Battery 59/61.
> Small enough for one session; recorded here because it edits villa's tool
> text, which is prompt text (CLAUDE.md rule 1).

## 0. The three rules

1. **Every villa price a person sees is `unit_quote()`'s**, now including
   the chat's. The tool result carries `price`, `included_guests`,
   `extra_guest_fee` and, with `guests`, `extra_guest_charge` and `total`,
   all as text, from `check_room_availability` (its `per_room` gate removed:
   the gate is now "has a rate"). The model is told to quote only from the
   tool and never to add up a total (the same lines harbor has; R-23, R-37).
2. **The documents keep the rules and lose the figures the database holds:**
   the six slot rates, "30 guests / ₱250", and the ₱4,000 December surcharge.
   Figures the database does not hold (extension, reservation fee, deposit,
   corkage, pets, add-ons) stay where they are.
3. **The stripped rules must stay true on the page**, so villa's calendar
   gets its fixed dates (24, 25, 31 Dec +₱4,000; 1 Jan; 12 Feb) for this year
   and next, and Holy Week 2027 (25–28 March). Holy Week moves: each year's
   is typed on S-7.

## 1. What changes

| Where | Change |
|---|---|
| `schema-customer-booking.sql` § 10 | `check_room_availability` returns rows for any tenant whose units have rates; zero rows for one with none (same signature, grants kept). **The user re-runs the file.** |
| `verify.mjs` 53 | the label: "no rates", not "whole_resort" |
| `@rag/bookings` | `checkPricedAvailability()` for any tenant; `checkRoomAvailability()` keeps its per_room 404 |
| `@rag/pipeline` `tools.ts` | villa's branch: when the tenant has a priced unit, the tool gains `guests`, the result the price columns, the prompt three price lines; a rate-less whole_resort tenant is unchanged |
| `dates.ts` | "how much", "magkano", "price", "rate", "cost", "presyo" make a dated question an availability turn |
| `sample-documents/02`, `05`, `08` | figures out, rules in; re-ingested by `plan/customer-booking-phase5-docs.mjs` |
| `plan/customer-booking-villa-rates.mjs` | villa's calendar, idempotent |
| the battery | `lang-tagalog` no longer expects 16,000 (no figure without a tool call); three `price-*` cases compare the reply with the TOOL's row |

## 2. Done when

- verify 92/92 after the SQL; villa's availability rows unchanged (the
  4-column function is untouched);
- rooms 30/30, both isolation suites both ways (villa's page and tool read
  only villa's rates);
- Northwind's and harbor's prompts and harbor's tool definitions
  byte-identical; villa's differ **by design**, saved as
  `plan/baseline/villa-*-post-villa-prices.txt`, the new baseline;
- full battery at its baseline plus the three new cases: `price 3/3`,
  every other group unchanged (expect **59/61**);
- the record: D-074, R-41 closed, R-17 closed, CLAUDE.md, flow.md.
