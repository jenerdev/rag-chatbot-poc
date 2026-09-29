# Sample documents — Alteza Hillside Resort

Eleven documents making up one knowledge base for the tenant `alteza`,
answering every question in [`../OWNER-QUESTIONNAIRE.md`](../OWNER-QUESTIONNAIRE.md).
Paste each one into the admin page (S-2) as a separate document, using the
file's first heading as the document title.

**This README is not part of the knowledge base: do not ingest it.** It
would put an index of the corpus into the corpus, which retrieves well and
answers nothing.

| File | Answers questionnaire section |
|---|---|
| `01-resort-overview.md` | 1 (the business, hours, contact, the guest limit, accessibility in brief) |
| `02-rooms-and-capacity.md` | 2 (rooms, included and maximum guests, children, what is provided) |
| `03-booking-periods-and-inclusions.md` | 3 and 6 (the two periods, weekend and holiday rules, inclusions, discounts, extensions) |
| `04-booking-and-payment.md` | 4 and 5 (the booking page, confirmation, the fee, GCash and bank details, proof, balance, deposit) |
| `05-cancellation-rescheduling-and-changes.md` | 8 and 14 (reschedule, cancel, weather closures, transfers, changes, reaching a person) |
| `06-house-rules.md` | 7 (quiet hours, guest count, food and corkage, pools, smoking, pets, damage, checkout) |
| `07-amenities-facilities-and-food.md` | 9, 10 and 11 in part (pools, kitchen, hall, Wi-Fi, power, nearby, accessibility) |
| `08-directions-parking-and-arrival.md` | 11 (by car, by public transport, parking, arrival) |
| `09-events-and-add-ons.md` | 12 (events, the hall fee, add-ons with fees, what is not offered) |
| `10-safety-weather-and-emergencies.md` | 13 (lifeguard, first aid, security, rain and typhoons, power, contacts) |
| `11-faq.md` | Part B, every guest question in short form |

## The content is invented

Alteza Hillside Resort is not a real resort. Every name, address, phone
number, account number, fee and rule in these files is made up, written as
a **draft for the owner to correct**. Before the documents go live, the
owner confirms or replaces at least: the address and the map pin; the
contact number and hours; the GCash and bank details (only the owner's
verified accounts may ever appear); the rooms and their included and
maximum guests; the reservation fee rule, the deposit, corkage, the pet
fee, the event fee and every add-on fee; the rescheduling and cancellation
terms; and the weather policy.

## What is deliberately NOT in these documents

Following the questionnaire's rule 2, no room rate, no surcharge amount
and no availability appears in any file. Those live in the database and
the chat quotes them from there:

- **Rooms screen:** the six rooms with their included guests, maximum
  guests and per-head extra-guest fee, and a weekday, weekend and (if
  different) holiday rate for each of the two periods, Day Use and
  Overnight. The Overnight period is the nightly one.
- **Holidays screen:** Holy Week each year; 24 and 31 December and
  1 January with the peak surcharge; the regular and special non-working
  holidays the owner wants at the weekend rate. 25 December is a closure,
  not a holiday rate: the owner blocks it by a staff booking or leaves it
  and declines requests.
- **Tenant settings** (questionnaire section 15): the fallback message in
  English, Taglish and Tagalog with the number 0918-224-7710; the booking
  page's "what happens next" text (the family replies within 24 hours and
  asks for the reservation fee; the room is held once it is received); the
  guest hint ("do not count children aged 5 and below").

The tenant needs the bookings application, `per_room`, and every room
priced, or the documents' references to "the booking page" and "this
chat's availability check" point at nothing.

## Facts to test retrieval with

Specific enough that a right answer can only have come from these files:

- The Loft Suite holds exactly two and takes no extra guest (`02`).
- Children aged five and below are not counted (`02`, `03`, `11`).
- The reservation fee is half the total, rounded up to the nearest hundred (`04`).
- Corkage is ₱2,000 and applies only to an outside caterer (`06`, `09`).
- The pools are cleaned every Wednesday from 6:00 to 8:00 AM (`06`).
- The generator does not run the air-conditioning or the induction stoves (`07`, `10`).
- The right chapel has a bell tower; the wrong one is a kilometre before it (`08`).
- The last jeep back to Tanay leaves Sampaloc at around 6:00 PM (`08`, `11`).
- The resort closes on 25 December (`01`, `03`).
