-- schema-booking-reference.sql — the 53rd file. Audit S-14, D-170.
--
-- booking_reference() (schema-staff-requests.sql, D-100) drew its six
-- letters with random(), which is not a cryptographic generator, and
-- checked only `bookings` for a reference already in use, while the UNIQUE
-- rule is on `stays` (stays_reference_unique). Now:
--   - the letters come from extensions.gen_random_bytes(), each of the 30
--     equally likely (rejection sampling: a byte of 240+ is drawn again);
--   - a reference counts as used if a booking OR a stay has it.
-- The shape, the alphabet, the caller check and the grants are unchanged.
--
-- What is left: two requests of the same tenant drawing the SAME new
-- reference in the same instant both pass the check, and the second meets
-- stays_reference_unique (23505, a 500). With 30^6 = 729,000,000 bodies per
-- tenant that is about 1 in 729 million per pair of simultaneous requests;
-- recorded (D-170), not retried.
--
-- The comment is this file's MARKER: the older definition in
-- schema-staff-requests.sql is skipped when it is there (trap 20).
-- Idempotent.

begin;

create or replace function public.booking_reference(p_tenant_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ2345679';   -- no 0 O 1 I L 8
  v_slug  text;
  v_ref   text;
  v_body  text;
  v_bytes bytea;
  v_byte  int;
  v_i     int;
begin
  -- session_user is the LOGIN role: 'authenticator' behind PostgREST (then
  -- SET ROLE to anon/authenticated/service_role), 'postgres' in the SQL editor
  -- or psql. A definer's current_user is its owner, so it cannot be used here.
  if session_user <> 'postgres'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'booking_reference: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;
  select t.slug into v_slug from public.tenants t where t.id = p_tenant_id;
  if v_slug is null then
    raise exception 'booking_reference: no tenant %', p_tenant_id using errcode = 'invalid_parameter_value';
  end if;
  loop
    -- D-170 (audit S-14): six letters from a cryptographic source, not
    -- random(). A byte of 240 or more is dropped and another drawn, so each
    -- of the 30 letters is exactly as likely as the others (240 = 8 x 30).
    v_body := '';
    while char_length(v_body) < 6 loop
      v_bytes := extensions.gen_random_bytes(12);
      for v_i in 0 .. 11 loop
        exit when char_length(v_body) = 6;
        v_byte := get_byte(v_bytes, v_i);
        if v_byte < 240 then
          v_body := v_body || substr(c_alphabet, 1 + (v_byte % 30), 1);
        end if;
      end loop;
    end loop;
    v_ref := upper(left(regexp_replace(v_slug, '[^a-zA-Z]', '', 'g') || 'XXX', 3)) || '-' || v_body;
    -- Free in BOTH places: a stay holds the unique reference
    -- (stays_reference_unique), its bookings carry it too.
    exit when not exists (select 1 from public.bookings b where b.tenant_id = p_tenant_id and b.reference = v_ref)
          and not exists (select 1 from public.stays s where s.tenant_id = p_tenant_id and s.reference = v_ref);
  end loop;
  return v_ref;
end;
$$;

comment on function public.booking_reference(bigint) is 'schema-booking-reference.sql (D-170): gen_random_bytes, unbiased; free in bookings and stays.';

revoke all on function public.booking_reference(bigint) from public, anon, authenticated;
grant execute on function public.booking_reference(bigint) to authenticated, service_role;

commit;
