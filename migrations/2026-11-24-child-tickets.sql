-- Child tickets (24 Nov 2026) — run once in the Supabase SQL editor.
--
-- Adds bookings.child_quantity and a p_child_quantity parameter to
-- create_hold. Safe to run more than once. The site's new code needs this
-- before it goes live; the old code keeps working with it.

alter table public.bookings add column if not exists child_quantity integer not null default 0;
alter table public.bookings drop constraint if exists bookings_child_quantity_check;
alter table public.bookings add constraint bookings_child_quantity_check
    check (child_quantity >= 0 and student_quantity + child_quantity <= quantity);

drop function if exists public.create_hold(text, date, text[], numeric, text, text, text, text, integer,
                                           text, text, text[], boolean, boolean, text, text, text, uuid, integer, jsonb);

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
    p_access_request  uuid    default null,
    p_student_quantity integer default 0,
    p_students        jsonb   default '[]',
    p_child_quantity  integer default 0
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
    v_students  jsonb := coalesce(p_students, '[]'::jsonb);
    v_email     text;
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
    if coalesce(p_student_quantity, 0) < 0 or coalesce(p_student_quantity, 0) > v_count then
        raise exception 'BAD_STUDENT_QUANTITY';
    end if;
    if coalesce(p_child_quantity, 0) < 0
       or coalesce(p_student_quantity, 0) + coalesce(p_child_quantity, 0) > v_count then
        raise exception 'BAD_CHILD_QUANTITY';
    end if;
    if jsonb_typeof(v_students) <> 'array' or jsonb_array_length(v_students) > coalesce(p_student_quantity, 0) then
        raise exception 'BAD_STUDENT_QUANTITY';
    end if;
    if not p_staff and jsonb_array_length(v_students) <> coalesce(p_student_quantity, 0) then
        raise exception 'STUDENT_NOT_VERIFIED';
    end if;
    if (select count(distinct lower(e->>'email')) from jsonb_array_elements(v_students) e)
       <> jsonb_array_length(v_students) then
        raise exception 'STUDENT_DUPLICATE';
    end if;

    -- One student ticket per school address, across both nights. Each address
    -- is locked (in a fixed order, so two bookings cannot deadlock) and then
    -- checked against confirmed bookings and holds that are still alive.
    for v_email in
        select lower(e->>'email') from jsonb_array_elements(v_students) e order by 1
    loop
        perform pg_advisory_xact_lock(hashtext('student:' || v_email));
        if exists (select 1 from public.booking_students bs
                   join public.bookings b on b.id = bs.booking_id
                   where bs.email = v_email
                     and (b.status = 'confirmed'
                          or (b.status = 'held' and b.held_until > now()))) then
            raise exception 'STUDENT_USED:%', v_email;
        end if;
    end loop;

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
        seats_requested, access_request_id, student_quantity, child_quantity
    ) values (
        p_reference, p_date, v_count, p_amount,
        p_name, p_email, nullif(p_phone, ''),
        coalesce(nullif(p_booked_by, ''), 'WEB'),
        case when p_confirm then 'confirmed' else 'held' end,
        case when p_confirm then null else now() + make_interval(mins => p_hold_minutes) end,
        coalesce(p_payment_status, 'unpaid'), p_payment_method, nullif(btrim(p_notes), ''),
        nullif(btrim(p_access_needs), ''), nullif(btrim(p_access_notes), ''),
        p_seats, p_access_request, coalesce(p_student_quantity, 0), coalesce(p_child_quantity, 0)
    )
    returning * into v_row;

    insert into public.booking_seats (performance_date, seat_id, booking_id)
    select p_date, s, v_row.id from unnest(p_seats) as s;

    insert into public.booking_students (booking_id, email, student_name)
    select v_row.id, lower(e->>'email'), coalesce(nullif(btrim(e->>'name'), ''), lower(e->>'email'))
    from jsonb_array_elements(v_students) e;

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

revoke execute on function public.create_hold(text, date, text[], numeric, text, text, text, text, integer,
                                              text, text, text[], boolean, boolean, text, text, text, uuid, integer, jsonb, integer)
    from public, anon, authenticated;
grant execute on function public.create_hold(text, date, text[], numeric, text, text, text, text, integer,
                                             text, text, text[], boolean, boolean, text, text, text, uuid, integer, jsonb, integer)
    to service_role;
