-- ===========================================================================
--  MAMMA MIA! — St Mary's Edenderry
--  Supabase schema
--
--  Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
--  Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Performances
-- ---------------------------------------------------------------------------
create table if not exists public.performances (
    key         date primary key,
    label       text        not null,
    capacity    integer     not null default 0 check (capacity >= 0),
    on_sale     boolean     not null default true,
    created_at  timestamptz not null default now()
);

comment on table public.performances is 'One row per show night.';

-- ---------------------------------------------------------------------------
-- 2. Bookings
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
    id                    uuid primary key default gen_random_uuid(),
    booking_reference     text        not null unique,
    performance_date      date        not null references public.performances(key) on delete restrict,
    quantity              integer     not null check (quantity > 0),
    amount                numeric(10,2) not null check (amount >= 0),

    customer_name         text        not null,
    customer_email        text        not null,
    customer_phone        text,

    booked_by             text        not null default 'WEB',   -- 'WEB' or a TY student's name

    -- What the party needs on the night. Codes only ('wheelchair,aisle'):
    -- wheelchair, aisle, hearing, other.
    -- The readable labels live in config.js and api/_show.js.
    access_needs          text,
    access_notes          text,

    status                text        not null default 'held'
                          check (status in ('held', 'confirmed', 'cancelled', 'expired')),
    payment_status        text        not null default 'unpaid'
                          check (payment_status in ('unpaid', 'paid', 'cash', 'refunded')),
    payment_method        text,                                  -- 'sumup' | 'cash' | 'comp'

    sumup_checkout_id     text,
    sumup_transaction_id  text,

    held_until            timestamptz,
    notes                 text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index if not exists bookings_perf_idx    on public.bookings (performance_date, status);
create index if not exists bookings_ref_idx     on public.bookings (booking_reference);
create index if not exists bookings_email_idx   on public.bookings (lower(customer_email));
create index if not exists bookings_created_idx on public.bookings (created_at desc);

-- Everyone who needs something on the night, per performance.
create index if not exists bookings_access_idx
    on public.bookings (performance_date)
    where access_needs is not null or access_notes is not null;

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch before update on public.bookings
for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Seats
--
--    The gym floor is described once, in seating.js — 16 rows of 27 across
--    three blocks, 432 seats a night — and both the booking page and the API
--    build the same ids from it. This table only records which of those ids
--    are spoken for, so re-drawing the plan never means a data migration.
--
--    The primary key is the whole point: two people cannot hold the same seat
--    on the same night, whatever the application does.
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

-- A hold that ran out of time, or a booking that was cancelled, still has its
-- rows here — and the primary key would keep those seats off sale forever.
-- create_hold calls this while holding the per-performance lock, so the seats
-- come back the moment anyone looks at that night.
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
-- 4. Message wall
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
    id          uuid primary key default gen_random_uuid(),
    author      text        not null,
    body        text        not null check (char_length(body) between 1 and 500),
    approved    boolean     not null default false,
    hidden      boolean     not null default false,
    created_at  timestamptz not null default now()
);

create index if not exists messages_feed_idx on public.messages (approved, hidden, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Availability view
--    A booking counts against capacity when it is confirmed, or held and the
--    hold has not yet expired.  Expired holds free themselves up — no cron job.
-- ---------------------------------------------------------------------------
create or replace view public.performance_availability as
select
    p.key,
    p.label,
    p.capacity,
    p.on_sale,
    coalesce(sum(b.quantity) filter (
        where b.status = 'confirmed'
           or (b.status = 'held' and b.held_until > now())
    ), 0)::int as sold,
    greatest(p.capacity - coalesce(sum(b.quantity) filter (
        where b.status = 'confirmed'
           or (b.status = 'held' and b.held_until > now())
    ), 0), 0)::int as remaining
from public.performances p
left join public.bookings b on b.performance_date = p.key
group by p.key, p.label, p.capacity, p.on_sale;

-- What is actually taken tonight, seat by seat. Same rule as above: an
-- expired hold's rows may still be sitting in booking_seats until the next
-- create_hold sweeps them, so they are filtered out here too.
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
-- 6. Atomic hold
--    Serialises per performance with an advisory lock so two people cannot
--    both take the last pair of tickets — or the same seat.
-- ---------------------------------------------------------------------------
-- Every added argument changed the signature, so the earlier versions have to
-- go: leaving them in place would make every create_hold call ambiguous.
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
-- 7. Lock everything down.
--    The website never talks to Postgres directly — every read and write goes
--    through the /api serverless functions using the service_role key, which
--    bypasses RLS.  With RLS on and no policies, the anon key can read nothing.
-- ---------------------------------------------------------------------------
alter table public.performances  enable row level security;
alter table public.bookings      enable row level security;
alter table public.booking_seats enable row level security;
alter table public.messages      enable row level security;

revoke all on public.performances  from anon, authenticated;
revoke all on public.bookings      from anon, authenticated;
revoke all on public.booking_seats from anon, authenticated;
revoke all on public.messages      from anon, authenticated;
revoke all on public.performance_availability from anon, authenticated;
revoke all on public.taken_seats              from anon, authenticated;
revoke execute on function public.release_stale_seats(date)   from anon, authenticated;
revoke execute on function public.release_booking_seats(text) from anon, authenticated;
revoke execute on function public.assign_seats(text, text[])  from anon, authenticated;
revoke execute on function public.create_hold(text, date, integer, numeric, text, text, text, text, integer, text, text, text[]) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Seed the performances
--    >>> EDIT THESE to match config.js before running <<<
--
--    Wednesday 27th is closed to ticket sales: on_sale = false makes
--    create_hold refuse it, and it is not listed in config.js, so no page
--    offers it.  Leave the row in place — bookings.performance_date still
--    references it, and it keeps the night off sale if anyone re-runs this.
--
--    Its capacity stays at the real hall figure: on_sale is what closes the
--    night, and zeroing capacity would only lose the seat count if the
--    matinee is ever put on sale.
--
--    That figure has to match the plan in seating.js — 432 seats a night.
--    Set it higher and the last tickets cannot be seated; set it lower and
--    the last seats cannot be sold.
-- ---------------------------------------------------------------------------
insert into public.performances (key, label, capacity, on_sale) values
    ('2027-01-27', 'Wednesday 27th January 2027', 432, false),
    ('2027-01-28', 'Thursday 28th January 2027',  432, true),
    ('2027-01-29', 'Friday 29th January 2027',    432, true)
on conflict (key) do update
    set label = excluded.label,
        capacity = excluded.capacity,
        on_sale = excluded.on_sale;

-- ---------------------------------------------------------------------------
-- Handy queries for later
-- ---------------------------------------------------------------------------
-- Tickets left tonight:
--     select * from public.performance_availability;
--
-- Door list:
--     select booking_reference, customer_name, quantity, booked_by
--     from public.bookings
--     where performance_date = '2027-01-28' and status = 'confirmed'
--     order by customer_name;
--
-- Who needs what on the night:
--     select performance_date, booking_reference, customer_name, quantity,
--            access_needs, access_notes
--     from public.bookings
--     where status = 'confirmed'
--       and (access_needs is not null or access_notes is not null)
--     order by performance_date, customer_name;
--
-- Total taken:
--     select sum(amount) from public.bookings
--     where status = 'confirmed' and payment_status in ('paid','cash');
