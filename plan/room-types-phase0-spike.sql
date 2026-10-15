-- room-types-phase0-spike.sql — plan/room-types.md Phase 0, spikes § 2.2 and § 2.3.
--
-- Paste into the Supabase SQL editor and run. It CHANGES NOTHING: the whole
-- script is one DO block that ends by RAISING its findings as an error, so
-- every temp object it made is rolled back with it. The "error" text IS the
-- result; copy it back.
--
-- § 2.2 The question: when one statement inserts several rows (a stay, a row
--   per night), does a query inside a BEFORE ROW trigger see the rows that
--   statement inserted EARLIER? The assigner needs it to keep a stay in one
--   room. Asked in the three shapes the doors use:
--     A  insert … values (…),(…),(…)             (a hand-written insert)
--     B  insert … select … from generate_series   (request_booking, decide_change)
--     C  insert … select … from json_populate_recordset   (PostgREST's multi-row insert:
--        createStaffStay, createBookings)
--   Each trigger call records how many earlier rows of its group it could see.
--   Seen = 0,1,2 means yes; 0,0,0 means no (and Phase 1 picks the room once per stay).
--
-- § 2.3 The question: what BEFORE triggers does public.bookings have, in the
--   order they fire (name order), so the assigner can be named to sort after
--   the ones that fill `during` and `group_id`.

do $$
declare
  v_a text;
  v_b text;
  v_c text;
  v_triggers text;
begin
  create temp table spike_rows (id serial primary key, grp int not null, night int not null, seen int);

  create function pg_temp.spike_seen() returns trigger language plpgsql volatile as $f$
  begin
    select count(*) into new.seen from spike_rows r where r.grp = new.grp;
    return new;
  end $f$;

  create trigger spike_seen before insert on spike_rows
    for each row execute function pg_temp.spike_seen();

  insert into spike_rows (grp, night) values (1, 0), (1, 1), (1, 2);
  insert into spike_rows (grp, night) select 2, n from generate_series(0, 2) as n order by n;
  insert into spike_rows (grp, night)
    select grp, night from json_populate_recordset(null::spike_rows,
      '[{"grp":3,"night":0},{"grp":3,"night":1},{"grp":3,"night":2}]');

  select string_agg(seen::text, ',' order by night) into v_a from spike_rows where grp = 1;
  select string_agg(seen::text, ',' order by night) into v_b from spike_rows where grp = 2;
  select string_agg(seen::text, ',' order by night) into v_c from spike_rows where grp = 3;

  select string_agg(format('%s [%s%s] %s()', t.tgname,
           case when t.tgtype & 2 = 2 then 'before' else 'after' end,
           concat_ws('', case when t.tgtype & 4 = 4 then ' insert' end,
                         case when t.tgtype & 16 = 16 then ' update' end,
                         case when t.tgtype & 8 = 8 then ' delete' end),
           p.proname), E'\n  ' order by t.tgname)
    into v_triggers
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.bookings'::regclass and not t.tgisinternal;

  raise exception E'SPIKE RESULT (nothing was changed)\n§ 2.2 rows seen by each BEFORE ROW call, nights 0,1,2:\n  A values: %\n  B generate_series: %\n  C json_populate_recordset: %\n§ 2.3 triggers on public.bookings, in firing (name) order:\n  %',
    v_a, v_b, v_c, v_triggers;
end $$;
