-- ===========================================================================
--  MAMMA MIA! — reserved seating
--
--  Run this THIRD, after schema.sql and schema-email.sql, in the Supabase
--  SQL Editor. Every database needs it: until it has run, every booking
--  fails with "Could not reserve your tickets", because the site calls
--  create_hold with seats.
--
--  Safe to re-run.
--
--  What it adds:
--    booking_seats        who has which seat — the primary key is what stops
--                         two people holding the same seat on the same night
--    seat_blocks          seats kept off public sale (sound desk, house seats)
--    accessible_releases  accessible seats an admin has put on general sale
--    access_requests      requests for accessible seating, from the booking page
--    bookings.seats_requested, seat_conflict, access_request_id
--    payment_status 'comp' for complimentary tickets
--
--  The seat ids ('A1' … 'T28') are not listed here on purpose. The hall is
--  described once, in seating.js, and both the website and the API build
--  the same ids from it. The API passes the accessible seats to create_hold
--  on every call, so the database enforces the rule without a second copy
--  of the plan.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Columns this file relies on, in case an older database lacks them
-- ---------------------------------------------------------------------------
alter table public.bookings add column if not exists access_needs text;
alter table public.bookings add column if not exists access_notes text;

-- ---------------------------------------------------------------------------
-- 1. Who has which seat
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
-- 2. Seats kept off public sale, and accessible seats put on it
-- ---------------------------------------------------------------------------
create table if not exists public.seat_blocks (
    performance_date date        not null references public.performances(key) on delete cascade,
    seat_id          text        not null check (seat_id ~ '^[A-Z]{1,2}[0-9]{1,3}$'),
    note             text,
    created_at       timestamptz not null default now(),
    primary key (performance_date, seat_id)
);

comment on table public.seat_blocks is
    'Seats an admin has taken off public sale for a night — sound desk, house seats. Staff can still book them.';

create table if not exists public.accessible_releases (
    performance_date date        not null references public.performances(key) on delete cascade,
    seat_id          text        not null check (seat_id ~ '^[A-Z]{1,2}[0-9]{1,3}$'),
    created_at       timestamptz not null default now(),
    primary key (performance_date, seat_id)
);

comment on table public.accessible_releases is
    'Accessible seats an admin has released to general sale for a night. A manual switch, never automatic.';

-- ---------------------------------------------------------------------------
-- 3. Access requests
-- ---------------------------------------------------------------------------
create table if not exists public.access_requests (
    id                 uuid primary key default gen_random_uuid(),
    reference          text        not null unique,                 -- AR-XXXXXX, quoted in emails
    performance_date   date        not null references public.performances(key) on delete restrict,
    name               text        not null,
    email              text        not null,
    phone              text,
    wheelchair_spaces  integer     not null default 0 check (wheelchair_spaces between 0 and 10),
    companion_seats    integer     not null default 0 check (companion_seats between 0 and 20),
    notes              text,
    status             text        not null default 'new'
                       check (status in ('new', 'contacted', 'seated', 'closed')),
    staff_notes        text,
    booking_reference  text,
    -- each email is claimed before it is sent, so a retry never doubles it
    team_claimed_at    timestamptz,
    team_emailed_at    timestamptz,
    ack_claimed_at     timestamptz,
    ack_emailed_at     timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create index if not exists access_requests_open_idx
    on public.access_requests (performance_date, status, created_at desc);

drop trigger if exists access_requests_touch on public.access_requests;
create trigger access_requests_touch before update on public.access_requests
for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. New columns on bookings
--
--    seats_requested   the seats the customer chose. Kept after a hold dies,
--                      so a payment that lands late can be given them back.
--    seat_conflict     paid, but its seats went to somebody else while the
--                      customer was away. Shown on the admin Overview until
--                      the office reseats them.
--    access_request_id the access request this booking was made from.
-- ---------------------------------------------------------------------------
alter table public.bookings add column if not exists seats_requested   text[];
alter table public.bookings add column if not exists seat_conflict     boolean not null default false;
alter table public.bookings add column if not exists access_request_id uuid references public.access_requests(id) on delete set null;

create index if not exists bookings_conflict_idx on public.bookings (performance_date) where seat_conflict;

-- Complimentary tickets get their own status. 'refunded' stays allowed so
-- nothing already stored can break, but the site no longer sets it — there
-- are no refunds.
alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings add constraint bookings_payment_status_check
    check (payment_status in ('unpaid', 'paid', 'cash', 'comp', 'refunded'));

-- Any confirmed booking taken before seats existed has none. Flag it, so it
-- shows on the admin Overview to be seated rather than its places being sold
-- again. (A no-op on a database with no such bookings.)
update public.bookings b
   set seat_conflict = true,
       notes = coalesce(b.notes || ' | ', '') || 'Booked before reserved seating — assign seats'
 where b.status = 'confirmed'
   and not b.seat_conflict
   and not exists (select 1 from public.booking_seats bs where bs.booking_id = b.id);

-- ---------------------------------------------------------------------------
-- 5. Let go of seats nobody is buying
--
--    A hold that ran out of time, or a booking that was cancelled, still has
--    its rows in booking_seats — and the primary key would keep those seats
--    off sale forever. This clears them. Everything that hands out seats
--    calls it while holding the per-performance lock, so an expired hold's
--    seats are free the moment anybody else wants them.
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
-- 6. What is actually taken tonight
--
--    Confirmed, or held and the hold has not run out. An expired hold's rows
--    may still be in the table until the next writer sweeps them, so they
--    are filtered here too — otherwise the map would grey out seats that are
--    on sale.
-- ---------------------------------------------------------------------------
-- performance_availability is rebuilt on top of taken_seats below, so it
-- has to go first.
drop view if exists public.performance_availability;
drop view if exists public.taken_seats;
create view public.taken_seats as
select
    bs.performance_date,
    bs.seat_id,
    bs.booking_id,
    b.booking_reference,
    b.status,
    b.payment_status,
    b.customer_name,
    b.access_needs
from public.booking_seats bs
join public.bookings b on b.id = bs.booking_id
where b.status = 'confirmed'
   or (b.status = 'held' and b.held_until > now());

-- Seats sold and held per night. What is left on public sale depends on the
-- accessible seats, which live in seating.js — the API works that part out.
create view public.performance_availability as
select
    p.key,
    p.label,
    p.on_sale,
    coalesce(count(t.seat_id) filter (where t.status = 'confirmed'), 0)::int as sold_seats,
    coalesce(count(t.seat_id) filter (where t.status = 'held'), 0)::int      as held_seats
from public.performances p
left join public.taken_seats t on t.performance_date = p.key
group by p.key, p.label, p.on_sale;

-- ---------------------------------------------------------------------------
-- 7. Hold seats — all of them or none
--
--    The one way a booking is made, online or by staff. Under a
--    per-performance advisory lock:
--      1. dead holds give their seats back
--      2. the night must exist and be on sale
--      3. for the public: no blocked seats, and no accessible seats unless
--         released (p_restricted is the accessible list from seating.js,
--         passed by the API — never by the browser)
--      4. no seat may already be taken
--      5. the booking and every seat row go in together
--
--    The checks in 3 and 4 name the seats that failed, so the customer is
--    told which ones went. The primary key on booking_seats is the backstop:
--    if two calls ever got past the lock at once, the second insert fails
--    and its whole transaction — booking included — rolls back.
--
--    The number of tickets is the number of seats.
-- ---------------------------------------------------------------------------
drop function if exists public.create_hold(text, date, integer, numeric, text, text, text, text, integer);
drop function if exists public.create_hold(text, date, integer, numeric, text, text, text, text, integer, text, text);
drop function if exists public.create_hold(text, date, integer, numeric, text, text, text, text, integer, text, text, text[]);
drop function if exists public.assign_seats(text, text[]);

create or replace function public.create_hold(
    p_reference       text,
    p_date            date,
    p_seats           text[],
    p_amount          numeric,
    p_name            text,
    p_email           text,
    p_phone           text,
    p_booked_by       text    default 'WEB',
    p_hold_minutes    integer default 15,
    p_access_needs    text    default null,
    p_access_notes    text    default null,
    p_restricted      text[]  default '{}',
    p_staff           boolean default false,
    p_confirm         boolean default false,
    p_payment_status  text    default 'unpaid',
    p_payment_method  text    default null,
    p_notes           text    default null,
    p_access_request  uuid    default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    v_on_sale   boolean;
    v_count     integer;
    v_bad       text;
    v_row       public.bookings;
begin
    select count(distinct s) into v_count from unnest(p_seats) as s;
    if p_seats is null or v_count = 0 then
        raise exception 'NO_SEATS';
    end if;
    if v_count <> cardinality(p_seats) then
        raise exception 'DUPLICATE_SEATS';
    end if;
    if p_confirm and not p_staff then
        raise exception 'NOT_ALLOWED';
    end if;

    -- one writer at a time per performance
    perform pg_advisory_xact_lock(hashtext(p_date::text));

    -- dead holds give their seats back before anyone looks
    perform public.release_stale_seats(p_date);

    select on_sale into v_on_sale from public.performances where key = p_date;
    if not found then
        raise exception 'UNKNOWN_PERFORMANCE';
    end if;
    if not v_on_sale then
        raise exception 'NOT_ON_SALE';
    end if;

    if not p_staff then
        -- accessible seats that have not been released
        select string_agg(s, ',' order by s) into v_bad
        from unnest(p_seats) as s
        where s = any(coalesce(p_restricted, '{}'))
          and not exists (select 1 from public.accessible_releases r
                          where r.performance_date = p_date and r.seat_id = s);
        if v_bad is not null then
            raise exception 'SEAT_RESTRICTED:%', v_bad;
        end if;

        -- blocked seats read as taken to the public: they are simply not for sale
        select string_agg(s, ',' order by s) into v_bad
        from unnest(p_seats) as s
        where exists (select 1 from public.seat_blocks k
                      where k.performance_date = p_date and k.seat_id = s);
        if v_bad is not null then
            raise exception 'SEAT_TAKEN:%', v_bad;
        end if;
    end if;

    select string_agg(s, ',' order by s) into v_bad
    from unnest(p_seats) as s
    where exists (select 1 from public.booking_seats bs
                  where bs.performance_date = p_date and bs.seat_id = s);
    if v_bad is not null then
        raise exception 'SEAT_TAKEN:%', v_bad;
    end if;

    insert into public.bookings (
        booking_reference, performance_date, quantity, amount,
        customer_name, customer_email, customer_phone,
        booked_by, status, held_until,
        payment_status, payment_method, notes,
        access_needs, access_notes,
        seats_requested, access_request_id
    ) values (
        p_reference, p_date, v_count, p_amount,
        p_name, p_email, nullif(p_phone, ''),
        coalesce(nullif(p_booked_by, ''), 'WEB'),
        case when p_confirm then 'confirmed' else 'held' end,
        case when p_confirm then null else now() + make_interval(mins => p_hold_minutes) end,
        coalesce(p_payment_status, 'unpaid'), p_payment_method, nullif(btrim(p_notes), ''),
        nullif(btrim(p_access_needs), ''), nullif(btrim(p_access_notes), ''),
        p_seats, p_access_request
    )
    returning * into v_row;

    insert into public.booking_seats (performance_date, seat_id, booking_id)
    select p_date, s, v_row.id from unnest(p_seats) as s;

    -- a booking made from an access request marks the request seated
    if p_access_request is not null then
        update public.access_requests
           set status = 'seated',
               booking_reference = p_reference
         where id = p_access_request;
    end if;

    return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Confirm a booking SumUp says was paid
--
--    The only way an online booking becomes confirmed — used by the live
--    verifier and by the reconciler alike.
--
--    The money is real, so the booking is always honoured. If its hold is
--    still alive it keeps its seats. If the hold died first and the seats
--    went back on sale, it gets them back when every one of them is still
--    free; if any has gone, it is confirmed with no seats and flagged as a
--    seat conflict, so the office can reseat the party together. It is never
--    given different seats behind anybody's back.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_paid_booking(
    p_reference      text,
    p_transaction_id text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row      public.bookings;
    v_have     integer;
    v_clash    text;
    v_conflict boolean := false;
begin
    select * into v_row from public.bookings where booking_reference = p_reference;
    if not found then
        raise exception 'UNKNOWN_BOOKING';
    end if;

    -- Already confirmed: nothing to do. Cancelled by the office: stays
    -- cancelled — a refreshed success page must not bring it back.
    if v_row.status not in ('held', 'expired') then
        return v_row;
    end if;

    perform pg_advisory_xact_lock(hashtext(v_row.performance_date::text));

    -- re-read under the lock: a second caller may have confirmed it meanwhile
    select * into v_row from public.bookings where booking_reference = p_reference;
    if v_row.status not in ('held', 'expired') then
        return v_row;
    end if;

    -- this booking's own expired rows go too, and come straight back below
    -- if nobody else has the seats
    perform public.release_stale_seats(v_row.performance_date);

    select count(*) into v_have from public.booking_seats where booking_id = v_row.id;

    if v_have = 0 and coalesce(cardinality(v_row.seats_requested), 0) > 0 then
        select string_agg(s, ',' order by s) into v_clash
        from unnest(v_row.seats_requested) as s
        where exists (select 1 from public.booking_seats bs
                      where bs.performance_date = v_row.performance_date and bs.seat_id = s)
           or exists (select 1 from public.seat_blocks k
                      where k.performance_date = v_row.performance_date and k.seat_id = s);

        if v_clash is null then
            insert into public.booking_seats (performance_date, seat_id, booking_id)
            select v_row.performance_date, s, v_row.id from unnest(v_row.seats_requested) as s;
        else
            v_conflict := true;
        end if;
    elsif v_have = 0 then
        v_conflict := true;                 -- paid with no seats on record at all
    end if;

    update public.bookings
       set status               = 'confirmed',
           payment_status       = 'paid',
           payment_method       = 'sumup',
           sumup_transaction_id = coalesce(p_transaction_id, sumup_transaction_id),
           held_until           = null,
           seat_conflict        = v_conflict,
           notes                = case
                                    when v_conflict
                                    then coalesce(notes || ' | ', '') ||
                                         'Paid after its hold ran out; seats ' ||
                                         coalesce(v_clash, '(none recorded)') ||
                                         ' had gone. Reseat this party.'
                                    when v_have = 0
                                    then coalesce(notes || ' | ', '') || 'Paid after its hold ran out; seats restored'
                                    else notes
                                  end
     where id = v_row.id
       and status in ('held', 'expired')   -- an admin cancel that slipped in first wins
    returning * into v_row;

    if not found then
        select * into v_row from public.bookings where booking_reference = p_reference;
    end if;

    return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Move a confirmed booking to different seats (admin)
--
--    Used to settle a seat conflict, or to move a party for any reason.
--    Staff may use any seat, accessible and blocked included. The number of
--    seats must match the tickets.
-- ---------------------------------------------------------------------------
create or replace function public.reseat_booking(p_reference text, p_seats text[])
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row   public.bookings;
    v_count integer;
    v_clash text;
begin
    select * into v_row from public.bookings where booking_reference = p_reference;
    if not found then
        raise exception 'UNKNOWN_BOOKING';
    end if;
    if v_row.status <> 'confirmed' then
        raise exception 'NOT_CONFIRMED';
    end if;

    select count(distinct s) into v_count from unnest(p_seats) as s;
    if p_seats is null or v_count <> cardinality(p_seats) or v_count <> v_row.quantity then
        raise exception 'SEAT_COUNT_MISMATCH:% for % tickets', coalesce(v_count, 0), v_row.quantity;
    end if;

    perform pg_advisory_xact_lock(hashtext(v_row.performance_date::text));
    perform public.release_stale_seats(v_row.performance_date);

    select string_agg(s, ',' order by s) into v_clash
    from unnest(p_seats) as s
    where exists (select 1 from public.booking_seats bs
                  where bs.performance_date = v_row.performance_date
                    and bs.seat_id = s and bs.booking_id <> v_row.id);
    if v_clash is not null then
        raise exception 'SEAT_TAKEN:%', v_clash;
    end if;

    delete from public.booking_seats where booking_id = v_row.id;
    insert into public.booking_seats (performance_date, seat_id, booking_id)
    select v_row.performance_date, s, v_row.id from unnest(p_seats) as s;

    update public.bookings
       set seat_conflict = false,
           seats_requested = p_seats
     where id = v_row.id
    returning * into v_row;

    return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Block or unblock seats for a night (admin)
--
--     A seat somebody already has cannot be blocked: move or cancel them first.
-- ---------------------------------------------------------------------------
create or replace function public.set_seat_blocks(
    p_date    date,
    p_seats   text[],
    p_blocked boolean,
    p_note    text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_clash text;
    v_count integer;
begin
    perform pg_advisory_xact_lock(hashtext(p_date::text));
    perform public.release_stale_seats(p_date);

    if not p_blocked then
        delete from public.seat_blocks where performance_date = p_date and seat_id = any(p_seats);
        get diagnostics v_count = row_count;
        return v_count;
    end if;

    select string_agg(s, ',' order by s) into v_clash
    from unnest(p_seats) as s
    where exists (select 1 from public.booking_seats bs
                  where bs.performance_date = p_date and bs.seat_id = s);
    if v_clash is not null then
        raise exception 'SEAT_TAKEN:%', v_clash;
    end if;

    insert into public.seat_blocks (performance_date, seat_id, note)
    select p_date, s, nullif(btrim(p_note), '') from unnest(p_seats) as s
    on conflict (performance_date, seat_id) do update set note = excluded.note;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Release accessible seats to general sale, or take them back (admin)
--
--     Taking a seat back is refused while anybody holds or has bought it.
--     The API checks the seats are accessible ones before calling.
-- ---------------------------------------------------------------------------
create or replace function public.set_accessible_release(
    p_date     date,
    p_seats    text[],
    p_released boolean
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_clash text;
    v_count integer;
begin
    perform pg_advisory_xact_lock(hashtext(p_date::text));
    perform public.release_stale_seats(p_date);

    if p_released then
        insert into public.accessible_releases (performance_date, seat_id)
        select p_date, s from unnest(p_seats) as s
        on conflict do nothing;
        get diagnostics v_count = row_count;
        return v_count;
    end if;

    select string_agg(s, ',' order by s) into v_clash
    from unnest(p_seats) as s
    where exists (select 1 from public.booking_seats bs
                  where bs.performance_date = p_date and bs.seat_id = s);
    if v_clash is not null then
        raise exception 'SEAT_TAKEN:%', v_clash;
    end if;

    delete from public.accessible_releases where performance_date = p_date and seat_id = any(p_seats);
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11b. Claim one of an access request's two emails
--
--      The team email and the requester's acknowledgement are each claimed
--      before sending, like confirmations, so the request handler and the
--      reconciler can never both send one. A claim older than ten minutes is
--      a send that died and can be taken again. p_kind is 'team' or 'ack'.
--      p_release hands a failed send's claim back; p_sent records success.
-- ---------------------------------------------------------------------------
create or replace function public.claim_access_email(
    p_id      uuid,
    p_kind    text,
    p_release boolean default false,
    p_sent    boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_count integer;
begin
    if p_kind not in ('team', 'ack') then
        raise exception 'UNKNOWN_KIND';
    end if;

    if p_sent then
        if p_kind = 'team' then
            update public.access_requests set team_emailed_at = now() where id = p_id;
        else
            update public.access_requests set ack_emailed_at = now() where id = p_id;
        end if;
        return true;
    end if;

    if p_release then
        if p_kind = 'team' then
            update public.access_requests set team_claimed_at = null where id = p_id and team_emailed_at is null;
        else
            update public.access_requests set ack_claimed_at = null where id = p_id and ack_emailed_at is null;
        end if;
        return true;
    end if;

    if p_kind = 'team' then
        update public.access_requests
           set team_claimed_at = now()
         where id = p_id
           and team_emailed_at is null
           and (team_claimed_at is null or team_claimed_at < now() - interval '10 minutes');
    else
        update public.access_requests
           set ack_claimed_at = now()
         where id = p_id
           and ack_emailed_at is null
           and (ack_claimed_at is null or ack_claimed_at < now() - interval '10 minutes');
    end if;

    get diagnostics v_count = row_count;
    return v_count = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Lock it all down, like everything else
--
--     The website never talks to Postgres directly — /api does, with the
--     service_role key, which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table public.booking_seats       enable row level security;
alter table public.seat_blocks         enable row level security;
alter table public.accessible_releases enable row level security;
alter table public.access_requests     enable row level security;

revoke all on public.booking_seats       from anon, authenticated;
revoke all on public.seat_blocks         from anon, authenticated;
revoke all on public.accessible_releases from anon, authenticated;
revoke all on public.access_requests     from anon, authenticated;
revoke all on public.taken_seats              from anon, authenticated;
revoke all on public.performance_availability from anon, authenticated;

revoke execute on function public.release_stale_seats(date)                  from public, anon, authenticated;
revoke execute on function public.release_booking_seats(text)                from public, anon, authenticated;
revoke execute on function public.confirm_paid_booking(text, text)           from public, anon, authenticated;
revoke execute on function public.reseat_booking(text, text[])               from public, anon, authenticated;
revoke execute on function public.set_seat_blocks(date, text[], boolean, text) from public, anon, authenticated;
revoke execute on function public.set_accessible_release(date, text[], boolean) from public, anon, authenticated;
revoke execute on function public.claim_access_email(uuid, text, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.create_hold(text, date, text[], numeric, text, text, text, text, integer,
                                              text, text, text[], boolean, boolean, text, text, text, uuid)
    from public, anon, authenticated;

-- Postgres lets PUBLIC execute every new function, so revoking anon alone
-- left these callable with the public anon key. Revoking PUBLIC closes that;
-- the API's service_role gets them back explicitly. The email functions from
-- schema-email.sql get the same treatment.
revoke execute on function public.claim_confirmation_email(text, boolean) from public, anon, authenticated;
revoke execute on function public.record_email_result(text, text, text, boolean, text, text, text) from public, anon, authenticated;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        -- Supabase normally grants these by default; said out loud so a
        -- re-run, which rebuilds the views, can never leave the API locked out.
        grant select, insert, update, delete on public.booking_seats, public.seat_blocks,
                                                public.accessible_releases, public.access_requests to service_role;
        grant select on public.taken_seats, public.performance_availability to service_role;
        grant execute on function public.release_stale_seats(date)                    to service_role;
        grant execute on function public.release_booking_seats(text)                  to service_role;
        grant execute on function public.confirm_paid_booking(text, text)             to service_role;
        grant execute on function public.reseat_booking(text, text[])                 to service_role;
        grant execute on function public.set_seat_blocks(date, text[], boolean, text) to service_role;
        grant execute on function public.set_accessible_release(date, text[], boolean) to service_role;
        grant execute on function public.claim_access_email(uuid, text, boolean, boolean) to service_role;
        grant execute on function public.claim_confirmation_email(text, boolean)      to service_role;
        grant execute on function public.record_email_result(text, text, text, boolean, text, text, text) to service_role;
        grant execute on function public.create_hold(text, date, text[], numeric, text, text, text, text, integer,
                                                     text, text, text[], boolean, boolean, text, text, text, uuid)
            to service_role;
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Handy queries for later
-- ---------------------------------------------------------------------------
-- Tonight's seats, in row order:
--     select seat_id, booking_reference, customer_name
--     from public.taken_seats
--     where performance_date = '2027-01-28'
--     order by substring(seat_id from '^[A-Z]+'), substring(seat_id from '[0-9]+$')::int;
--
-- Paid bookings still waiting for seats:
--     select booking_reference, performance_date, customer_name, quantity, seats_requested
--     from public.bookings where seat_conflict;
--
-- Open access requests:
--     select reference, performance_date, name, wheelchair_spaces, companion_seats, status
--     from public.access_requests where status in ('new', 'contacted') order by created_at;
