-- ===========================================================================
--  MAMMA MIA! — St Mary's Edenderry
--  Supabase schema
--
--  Run this FIRST in the Supabase SQL Editor (Dashboard → SQL Editor → New
--  query), then schema-email.sql, then schema-seating.sql. All three are
--  needed; all three are safe to re-run.
--
--  This file is the base: performances, bookings and the message wall.
--  Seats, holds and access requests are in schema-seating.sql.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Performances
-- ---------------------------------------------------------------------------
create table if not exists public.performances (
    key         date primary key,
    label       text        not null,
    -- No longer used: what is on sale comes from the seat plan in seating.js.
    -- Kept so older code and queries do not break.
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
                          check (payment_status in ('unpaid', 'paid', 'cash', 'comp', 'refunded')),
    payment_method        text,               -- 'sumup' | 'cash' | 'card_door' | 'comp'

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
-- 4. Lock everything down.
--    The website never talks to Postgres directly — every read and write goes
--    through the /api serverless functions using the service_role key, which
--    bypasses RLS.  With RLS on and no policies, the anon key can read nothing.
-- ---------------------------------------------------------------------------
alter table public.performances  enable row level security;
alter table public.bookings      enable row level security;
alter table public.messages      enable row level security;

revoke all on public.performances  from anon, authenticated;
revoke all on public.bookings      from anon, authenticated;
revoke all on public.messages      from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Seed the performances
--    >>> EDIT THESE to match config.js before running <<<
--
--    Wednesday 27th is closed to ticket sales: on_sale = false makes
--    create_hold refuse it, and it is not listed in config.js, so no page
--    offers it.  Leave the row in place — bookings.performance_date still
--    references it, and it keeps the night off sale if anyone re-runs this.
--
--    There is no capacity to set: every night has the seats in seating.js,
--    less the accessible seats not released and any seats blocked in admin.
-- ---------------------------------------------------------------------------
insert into public.performances (key, label, on_sale) values
    ('2027-01-27', 'Wednesday 27th January 2027', false),
    ('2027-01-28', 'Thursday 28th January 2027',  true),
    ('2027-01-29', 'Friday 29th January 2027',    true)
on conflict (key) do update
    set label = excluded.label,
        on_sale = excluded.on_sale;

-- ---------------------------------------------------------------------------
-- Handy queries for later
-- ---------------------------------------------------------------------------
-- Seats sold and held per night (needs schema-seating.sql):
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
--
-- Complimentary tickets per night:
--     select performance_date, sum(quantity) from public.bookings
--     where status = 'confirmed' and payment_status = 'comp' group by 1;
