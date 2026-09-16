-- ===========================================================================
--  MAMMA MIA! — reserved seating
--
--  Run this AFTER schema.sql on a database that was created before seats were
--  chosen at booking. A database set up from the current schema.sql already
--  has everything below.
--
--  Safe to re-run.
--
--  The seat ids ('A1' … 'V25') are not listed here on purpose. The gym floor
--  is described once, in seating.js, and both the booking page and the API
--  build the same 500 ids from it. This table only records which of them are
--  spoken for, so re-drawing the plan never means a data migration.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Who has which seat
--
--    The primary key is the whole point: two people cannot hold the same
--    seat on the same night, whatever the application does. Everything else
--    below is there to make sure the row goes away again when a hold dies.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_seats (
    performance_date date        not null references public.performances(key) on delete restrict,
    seat_id          text        not null check (seat_id ~ '^[A-Z]{1,2}[0-9]{1,3}$'),
    booking_id       uuid        not null references public.bookings(id) on delete cascade,
    created_at       timestamptz not null default now(),
    primary key (performance_date, seat_id)
);

comment on table public.booking_seats is
    'One row per seat taken. Seat ids come from seating.js, never from here.';

create index if not exists booking_seats_booking_idx on public.booking_seats (booking_id);

-- ---------------------------------------------------------------------------
-- 2. Let go of seats nobody is buying
--
--    A hold that ran out of time, or a booking that was cancelled, still has
--    its rows in booking_seats — and the primary key would keep those seats
--    off sale forever. This clears them. create_hold calls it while holding
--    the per-performance lock, so the seats come back the moment anyone
--    looks at that night.
-- ---------------------------------------------------------------------------
create or replace function public.release_stale_seats(p_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_count integer;
begin
    delete from public.booking_seats bs
    using public.bookings b
    where bs.booking_id = b.id
      and bs.performance_date = p_date
      and (b.status in ('cancelled', 'expired')
           or (b.status = 'held' and (b.held_until is null or b.held_until <= now())));

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- Put a cancelled booking's seats straight back on sale, by reference.
create or replace function public.release_booking_seats(p_reference text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_count integer;
begin
    delete from public.booking_seats bs
    using public.bookings b
    where bs.booking_id = b.id
      and b.booking_reference = p_reference;

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Seats for a booking that lost them
--
--     A customer can pay and then vanish — the browser closes, the phone dies —
--     and their hold runs out before anyone hears from SumUp. By the time the
--     reconciler finds the payment an hour later, release_stale_seats has put
--     those seats back and somebody else may have bought them.
--
--     The money is real, so the booking stands and simply needs seats again.
--     This takes the same per-performance lock create_hold uses, so the seats
--     it hands out cannot be sold underneath it. A booking that still has its
--     seats keeps exactly the ones it had.
-- ---------------------------------------------------------------------------
create or replace function public.assign_seats(p_reference text, p_seats text[])
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_booking public.bookings;
    v_clash   text;
    v_have    text[];
begin
    select * into v_booking from public.bookings where booking_reference = p_reference;
    if not found then
        raise exception 'UNKNOWN_BOOKING';
    end if;

    perform pg_advisory_xact_lock(hashtext(v_booking.performance_date::text));
    perform public.release_stale_seats(v_booking.performance_date);

    select array_agg(seat_id order by seat_id) into v_have
    from public.booking_seats where booking_id = v_booking.id;

    if v_have is not null then
        return v_have;                      -- already seated; leave well alone
    end if;

    if p_seats is null or array_length(p_seats, 1) is distinct from v_booking.quantity then
        raise exception 'SEAT_COUNT_MISMATCH';
    end if;

    select string_agg(s, ',' order by s) into v_clash
    from unnest(p_seats) as s
    where exists (
        select 1 from public.booking_seats bs
        where bs.performance_date = v_booking.performance_date and bs.seat_id = s
    );

    if v_clash is not null then
        raise exception 'SEAT_TAKEN:%', v_clash;
    end if;

    insert into public.booking_seats (performance_date, seat_id, booking_id)
    select distinct v_booking.performance_date, s, v_booking.id from unnest(p_seats) as s;

    return p_seats;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. What is actually taken tonight
--
--    Same rule as performance_availability: confirmed, or held and the hold
--    has not run out. An expired hold's rows may still be sitting in the
--    table until the next create_hold sweeps them, so they are filtered here
--    too — otherwise the map would show seats as gone that are on sale.
-- ---------------------------------------------------------------------------
create or replace view public.taken_seats as
select
    bs.performance_date,
    bs.seat_id,
    bs.booking_id,
    b.booking_reference,
    b.status,
    b.customer_name,
    b.access_needs
from public.booking_seats bs
join public.bookings b on b.id = bs.booking_id
where b.status = 'confirmed'
   or (b.status = 'held' and b.held_until > now());

-- ---------------------------------------------------------------------------
-- 4. Hold the tickets and the seats in one go
--
--    create_hold gains p_seats. Postgres treats a new argument list as a new
--    function, so the eleven-argument version has to be dropped — with both
--    in place every call would be ambiguous.
--
--    p_seats null still works: a booking with no seats chosen, which is what
--    a database carried over from before this change already has.
-- ---------------------------------------------------------------------------
drop function if exists public.create_hold(text, date, integer, numeric, text, text, text, text, integer);
drop function if exists public.create_hold(text, date, integer, numeric, text, text, text, text, integer, text, text);

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
    p_access_notes  text default null,
    p_seats         text[] default null
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
    v_seats     integer;
    v_clash     text;
    v_row       public.bookings;
begin
    if p_quantity is null or p_quantity < 1 then
        raise exception 'INVALID_QUANTITY';
    end if;

    -- one writer at a time per performance
    perform pg_advisory_xact_lock(hashtext(p_date::text));

    -- dead holds give their seats back before anyone counts them
    perform public.release_stale_seats(p_date);

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

    -- Seats, when the booking chose them. Checked here rather than left to
    -- the primary key so the customer is told which seat went, not just that
    -- something did — and the check is trustworthy because every writer for
    -- this performance is queued behind the advisory lock above.
    if p_seats is not null then
        select count(distinct s) into v_seats from unnest(p_seats) as s;

        if v_seats <> p_quantity then
            raise exception 'SEAT_COUNT_MISMATCH:% for % tickets', v_seats, p_quantity;
        end if;

        select string_agg(s, ',' order by s) into v_clash
        from unnest(p_seats) as s
        where exists (
            select 1 from public.booking_seats bs
            where bs.performance_date = p_date and bs.seat_id = s
        );

        if v_clash is not null then
            raise exception 'SEAT_TAKEN:%', v_clash;
        end if;
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

    if p_seats is not null then
        insert into public.booking_seats (performance_date, seat_id, booking_id)
        select distinct p_date, s, v_row.id from unnest(p_seats) as s;
    end if;

    return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Lock it down, like everything else
--
--    The website never talks to Postgres directly — /api does, with the
--    service_role key, which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table public.booking_seats enable row level security;

revoke all on public.booking_seats from anon, authenticated;
revoke all on public.taken_seats  from anon, authenticated;
revoke execute on function public.release_stale_seats(date)    from anon, authenticated;
revoke execute on function public.release_booking_seats(text)  from anon, authenticated;
revoke execute on function public.assign_seats(text, text[])   from anon, authenticated;
revoke execute on function public.create_hold(text, date, integer, numeric, text, text, text, text, integer, text, text, text[]) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Capacity has to match the plan
--
--    seating.js lays out 500 seats a night. If capacity says something else,
--    either the last tickets cannot be seated or the last seats cannot be
--    sold, so keep the two in step.
-- ---------------------------------------------------------------------------
update public.performances set capacity = 500 where on_sale and capacity <> 500;

-- ---------------------------------------------------------------------------
-- Handy queries for later
-- ---------------------------------------------------------------------------
-- Tonight's seat map, in row order:
--     select seat_id, booking_reference, customer_name
--     from public.taken_seats
--     where performance_date = '2027-01-28'
--     order by left(seat_id, 1), substring(seat_id from 2)::int;
--
-- Where the wheelchair parties are sitting:
--     select seat_id, customer_name, access_needs
--     from public.taken_seats
--     where performance_date = '2027-01-28' and access_needs is not null
--     order by seat_id;
--
-- Seats sold per night:
--     select performance_date, count(*) from public.taken_seats
--     where status = 'confirmed' group by 1;
