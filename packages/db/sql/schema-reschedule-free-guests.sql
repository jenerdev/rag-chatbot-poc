-- schema-reschedule-free-guests.sql — the 48th file. Audit B-3, D-161.
--
-- decide_change() (schema-manage-booking.sql, D-108) approves a reschedule
-- by cancelling the stay's live rows and inserting them again on the new
-- dates. Its insert names the columns it copies, and it was written on
-- 2026-10-10, before free guests (D-147, 2026-10-26, schema-free-guests.sql)
-- added `bookings.free_guests`. That column has a default, 0, so the insert
-- did not fail: it silently set every moved night to "no free children".
-- A stay of "4 guests + 1 child (free)" became "4 guests" on approval, on
-- every screen and in the guest's own Manage booking (trap 23's cousin: a
-- column with a default is the one an old insert forgets without a sound).
--
-- This file replaces decide_change() with the same body plus `free_guests`
-- in the copied columns. Nothing else changes:
--   - the PROMO is still not carried, on purpose (D-108: "no promo is
--     carried"; request_change() quotes the move without it, and that quote
--     is what the guest saw). The audit called this half a bug; the user
--     confirmed D-108 on 2026-11-14 (D-161).
--   - the price never reads free_guests (D-147), so no amount moves.
--   - walk_in stays on the stay (schema-walk-in.sql), as before.
--
-- The comment on the function is this file's MARKER: schema-manage-booking
-- skips its own older definition when it is there (CLAUDE.md trap 20).
--
-- Idempotent. Same signature, so the grants are restated, not changed.

begin;

create or replace function public.decide_change(p_tenant_id bigint, p_id bigint, p_action text, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_req    public.change_requests%rowtype;
  v_status text;
  v_shift  int;
  v_check  date;
  v_old    bigint[];
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_admin() then
    raise exception 'Only an owner or admin of this business can decide a change request.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_req from public.change_requests c where c.tenant_id = p_tenant_id and c.id = p_id for update;
  if not found then
    raise exception 'no such request' using errcode = 'no_data_found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request was already %.', v_req.status using errcode = 'object_not_in_prerequisite_state';
  end if;

  if p_action = 'reject' then
    if char_length(btrim(coalesce(p_note, ''))) not between 1 and 500 then
      raise exception 'Say why (the guest reads it), in at most 500 characters.' using errcode = 'invalid_parameter_value';
    end if;
    update public.change_requests set status = 'rejected', decision_note = btrim(p_note), decided_by = auth.uid(), decided_at = now()
    where id = v_req.id;
    return jsonb_build_object('status', 'rejected');
  elsif p_action <> 'approve' then
    raise exception 'The action is "approve" or "reject".' using errcode = 'invalid_parameter_value';
  end if;

  v_status := public.stay_status(p_tenant_id, v_req.group_id);
  if v_req.kind = 'cancel' then
    update public.bookings b
    set status = 'cancelled', decision_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Cancelled at the guest''s request')
    where b.tenant_id = p_tenant_id and b.group_id = v_req.group_id and b.status in ('pending', 'confirmed');
  else
    if v_status <> 'confirmed' then
      raise exception 'Only a confirmed booking can be moved; this one is %.', v_status using errcode = 'object_not_in_prerequisite_state';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('request_booking:' || p_tenant_id::text, 0));
    select min(b.booked_date), array_agg(b.id) into v_check, v_old from public.bookings b
    where b.tenant_id = p_tenant_id and b.group_id = v_req.group_id and b.status = 'confirmed';
    v_shift := v_req.new_check_in - v_check;
    update public.bookings b
    set status = 'cancelled', decision_note = format('Rescheduled to %s', v_req.new_check_in)
    where b.id = any(v_old);
    -- D-161: free_guests is copied with the paying count. No promo_id (D-108).
    insert into public.bookings (tenant_id, unit_id, slot_id, booked_date, guest_name, guest_phone, guest_email, guest_count,
                                 free_guests, notes, status, source, group_id, reference, decision_note)
    select b.tenant_id, b.unit_id, b.slot_id, b.booked_date + v_shift, b.guest_name, b.guest_phone, b.guest_email, b.guest_count,
           b.free_guests, b.notes, 'confirmed', b.source, b.group_id, b.reference, format('Moved from %s', v_check)
    from public.bookings b
    where b.id = any(v_old)
    order by b.booked_date, b.id;
  end if;

  update public.change_requests set status = 'approved', decision_note = nullif(btrim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now()
  where id = v_req.id;
  return jsonb_build_object('status', 'approved', 'payment', public.stay_payment(p_tenant_id, v_req.group_id));
end;
$$;

comment on function public.decide_change(bigint, bigint, text, text) is 'schema-reschedule-free-guests.sql (D-161): a moved stay keeps its free guests; no promo is carried (D-108).';

revoke all on function public.decide_change(bigint, bigint, text, text) from public, anon;
grant execute on function public.decide_change(bigint, bigint, text, text) to authenticated, service_role;

commit;
