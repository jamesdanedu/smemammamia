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
-- 3. Message wall
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
-- 4. Availability view
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

-- ---------------------------------------------------------------------------
-- 5. Atomic hold
--    Serialises per performance with an advisory lock so two people cannot
--    both take the last pair of tickets.
-- ---------------------------------------------------------------------------
-- Adding the accessibility arguments changed the signature, so the earlier
-- nine-argument version has to go: leaving it in place would make every
-- create_hold call ambiguous.
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
-- 6. Lock everything down.
--    The website never talks to Postgres directly — every read and write goes
--    through the /api serverless functions using the service_role key, which
--    bypasses RLS.  With RLS on and no policies, the anon key can read nothing.
-- ---------------------------------------------------------------------------
alter table public.performances enable row level security;
alter table public.bookings     enable row level security;
alter table public.messages     enable row level security;

revoke all on public.performances from anon, authenticated;
revoke all on public.bookings     from anon, authenticated;
revoke all on public.messages     from anon, authenticated;
revoke all on public.performance_availability from anon, authenticated;
revoke execute on function public.create_hold(text, date, integer, numeric, text, text, text, text, integer, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Seed the performances
--    >>> EDIT THESE to match config.js before running <<<
-- ---------------------------------------------------------------------------
insert into public.performances (key, label, capacity) values
    ('2027-01-27', 'Wednesday 27th January 2027', 500),
    ('2027-01-28', 'Thursday 28th January 2027', 500),
    ('2027-01-29', 'Friday 29th January 2027', 500)
on conflict (key) do update
    set label = excluded.label,
        capacity = excluded.capacity;

-- ---------------------------------------------------------------------------
-- Handy queries for later
-- ---------------------------------------------------------------------------
-- Tickets left tonight:
--     select * from public.performance_availability;
--
-- Door list:
--     select booking_reference, customer_name, quantity, booked_by
--     from public.bookings
--     where performance_date = '2027-01-27' and status = 'confirmed'
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
