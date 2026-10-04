-- schema-pending-default.sql — a booking is born PENDING (D-095).
--
-- Run after schema-customer-booking.sql. Idempotent.
--
-- The user's rule, 2026-10-04: "Booking created by a staff should not be
-- automatically confirmed." The staff route and @rag/bookings now insert
-- `pending` unless told otherwise, and PATCH /bookings/[id] confirms. This
-- file is the second wall: a raw insert that names no status is pending too,
-- so no path can create a confirmed booking by omission. A pending row holds
-- nothing (bookings_no_overlap covers `confirmed` only, D-070), so the
-- moment of confirmation is the moment the span is taken, and a clash is
-- refused there.
--
-- No existing row changes: a default applies to new rows only.

alter table public.bookings alter column status set default 'pending';
