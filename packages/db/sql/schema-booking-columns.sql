-- schema-booking-columns.sql — the 51st file. Audit S-11, D-167.
--
-- Bookings are not in the audit log (D-138): they keep booking_events, which
-- the triggers write for every status change, move and decision. But a staff
-- token could UPDATE any column the row policy let it reach: the guest's
-- name, phone and email, the notes, `held`, `source`, a count, a price
-- column. No screen does (the app updates `status` and `decision_note`
-- only: confirm, decline, cancel, every one logged), yet a token used
-- directly could, and nothing would say who changed a guest's phone number.
--
-- So the database now allows a token to update exactly those two columns.
-- Everything else that changes a booking already goes through a SECURITY
-- DEFINER function that writes its own event (decide_change, move_room,
-- hold_stay, release_stay, expire_due_stays, review_payment,
-- remove_guest_details, the hold-release trigger), and those run as the
-- table owner, so a column grant on `authenticated` does not touch them. A
-- BEFORE trigger that changes the row being written (prices, the room, the
-- extra-guest count) is not checked against column privileges either.
--
-- A new staff edit of another column needs a definer function that logs
-- it, or a line here and an event; never a wider grant without a log.
--
-- Idempotent. INSERT, SELECT and DELETE are unchanged (the policies decide).

begin;

revoke update on public.bookings from anon, authenticated;
grant update (status, decision_note) on public.bookings to authenticated;

commit;
