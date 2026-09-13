-- ===========================================================================
--  MAMMA MIA! — accessibility requests taken at booking
--
--  Run this AFTER schema.sql on a database that was created before the
--  booking form started asking the accessibility question. A database set up
--  from the current schema.sql already has everything below.
--
--  Safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. What the party needs on the night
--
--    access_needs holds codes, never labels, so the wording on the booking
--    form can change without touching bookings already taken:
--        wheelchair, aisle, hearing, other
--    stored comma-separated, e.g. 'wheelchair,aisle'.
--    The labels live in config.js (browser) and api/_show.js (server).
--
--    access_notes is whatever the customer typed in their own words.
-- ---------------------------------------------------------------------------
alter table public.bookings add column if not exists access_needs text;
alter table public.bookings add column if not exists access_notes text;

-- Everyone who needs something on the night, per performance.
create index if not exists bookings_access_idx
    on public.bookings (performance_date)
    where access_needs is not null or access_notes is not null;

-- ---------------------------------------------------------------------------
-- 2. Carry the answers through the hold
--
--    create_hold gains two arguments. Postgres treats that as a different
--    function rather than a replacement, so the nine-argument version has to
--    be dropped — with both in place every call would be ambiguous.
-- ---------------------------------------------------------------------------
drop function if exists public.create_hold(text, date, integer, numeric, text, text, text, text, integer);

create or replace function public.create_hold(
    p_reference     text,
    p_date          date,
    p_quantity      integer,
    p_amount        numeric,
    p_name          text,
    p_email         text,
    p_phone         text,
    p_booked_by     text default 'WEB',
    p_hold_minutes  integer default 15,
    p_access_needs  text default null,
    p_access_notes  text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    v_capacity  integer;
    v_on_sale   boolean;
    v_taken     integer;
    v_row       public.bookings;
begin
    if p_quantity is null or p_quantity < 1 then
        raise exception 'INVALID_QUANTITY';
    end if;

    -- one writer at a time per performance
    perform pg_advisory_xact_lock(hashtext(p_date::text));

    select capacity, on_sale into v_capacity, v_on_sale
    from public.performances where key = p_date;

    if not found then
        raise exception 'UNKNOWN_PERFORMANCE';
    end if;

    if not v_on_sale then
        raise exception 'NOT_ON_SALE';
    end if;

    select coalesce(sum(quantity), 0) into v_taken
    from public.bookings
    where performance_date = p_date
      and (status = 'confirmed' or (status = 'held' and held_until > now()));

    if v_taken + p_quantity > v_capacity then
        raise exception 'SOLD_OUT:%', greatest(v_capacity - v_taken, 0);
    end if;

    insert into public.bookings (
        booking_reference, performance_date, quantity, amount,
        customer_name, customer_email, customer_phone,
        booked_by, status, held_until,
        access_needs, access_notes
    ) values (
        p_reference, p_date, p_quantity, p_amount,
        p_name, p_email, nullif(p_phone, ''),
        coalesce(nullif(p_booked_by, ''), 'WEB'), 'held',
        now() + make_interval(mins => p_hold_minutes),
        nullif(btrim(p_access_needs), ''), nullif(btrim(p_access_notes), '')
    )
    returning * into v_row;

    return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Lock the new signature down
-- ---------------------------------------------------------------------------
revoke execute on function public.create_hold(text, date, integer, numeric, text, text, text, text, integer, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Handy queries
-- ---------------------------------------------------------------------------
-- Who needs what, one night at a time:
--     select booking_reference, customer_name, quantity, access_needs, access_notes
--     from public.bookings
--     where performance_date = '2027-01-27' and status = 'confirmed'
--       and (access_needs is not null or access_notes is not null)
--     order by customer_name;
--
-- How many wheelchair spaces to keep, per night:
--     select performance_date, count(*) as bookings, sum(quantity) as people
--     from public.bookings
--     where status = 'confirmed' and access_needs like '%wheelchair%'
--     group by performance_date order by performance_date;
