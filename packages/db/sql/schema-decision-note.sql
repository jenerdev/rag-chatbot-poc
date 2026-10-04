-- schema-decision-note.sql — a note on the decision (D-096).
--
-- Run after schema-pending-default.sql. Idempotent.
--
-- The user, 2026-10-04: "add notes field when cancelling, confirming,
-- declining booking". One nullable column, written by the staff update
-- that changes the status (cancelBooking, confirmBooking, the request
-- decision), never by a customer: request_booking() does not name it, and
-- a chat token has no update policy on bookings. Shown on the row under
-- the status. Bounded like `notes`.

alter table public.bookings add column if not exists decision_note text;
alter table public.bookings drop constraint if exists bookings_decision_note_length;
alter table public.bookings add constraint bookings_decision_note_length check (decision_note is null or char_length(decision_note) <= 500);
