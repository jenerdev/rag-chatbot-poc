-- schema-consent-only.sql — the 52nd file. Audit S-12, D-168.
--
-- The booking page's one write is request_booking_with_consent() (D-130):
-- it refuses a request without the tenant's CURRENT policy version and
-- records the consent on the stay. But request_booking() itself, the
-- function the wrapper calls, was still executable by `authenticated`, so a
-- chat token could book without consent (a stay with no consent recorded).
-- Chat tokens never leave the server; this closes the door anyway.
--
-- Now only the wrapper reaches it: the wrapper is SECURITY DEFINER and runs
-- as the owner, who keeps EXECUTE; `service_role` keeps it for tools. A token
-- calling request_booking() directly is 42501.
--
-- The comment is this file's MARKER: schema-free-guests.sql, which created
-- the function and granted it to `authenticated`, skips that grant when the
-- marker is there (CLAUDE.md trap 20). Idempotent.

begin;

revoke execute on function public.request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, int[]) from public, anon, authenticated;
grant execute on function public.request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, int[]) to service_role;
comment on function public.request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, int[]) is 'schema-consent-only.sql (D-168): only request_booking_with_consent() and service_role call this.';

commit;
