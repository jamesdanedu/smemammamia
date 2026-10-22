# Mamma Mia! — St Mary's Secondary School, Edenderry

Ticket booking website for the school musical. Static pages on Vercel, a handful of
serverless functions for anything that touches money or data, Supabase for storage,
SumUp for card payments.

**The run:** Thursday 28 and Friday 29 January 2027, doors 7:00 PM, curtain
7:30 PM. €10 flat, 504 seats a night, at St Mary's Secondary School, Edenderry,
Co. Offaly. Two acts, suitable for ages 13+ (PG-13). **Seating is reserved** —
pick a night, then pick your seats on the hall plan; the number of seats is the
number of tickets. Bookings are identified by a reference in the form
`MM-XXXXXX`. There are no refunds: a ticket that is not wanted can be passed on,
and whoever comes gives the booking name or reference at the door.

The Wednesday 27 January performance is a free schools matinee and is **not sold
through this site**. It is deliberately absent from `CONFIG.performances` in
`config.js`, so no page lists it, and its row in `performances` is seeded with
`on_sale = false`, so `create_hold` refuses it even if a date is posted by hand.
The site says nothing about it — if that ever changes, it is two edits: add the
night back to `config.js` and turn *On sale* on in admin *Settings*.

*Mamma Mia!* — music and lyrics by Benny Andersson and Björn Ulvaeus, and some songs
with Stig Anderson; book by Catherine Johnson; originally conceived by Judy Craymer;
additional material and arrangements by Martin Koch. Licensed through **Music Theatre
International (MTI)** — see *Licensing* below, which is not optional reading.

> ### This is a separate deployment from the Popstars site
>
> Mamma Mia! gets **its own GitHub repo, its own Vercel project and its own Supabase
> project**. Do not point this deployment at the Popstars database, and do not add
> these pages to the Popstars Vercel project. The two shows use the same table names
> (`performances`, `bookings`, `messages`), so a shared database would mix both
> shows' bookings into one set of rows — wrong capacity counts, wrong door lists,
> wrong money, and no clean way to untangle it afterwards. One show, one database.

Three things this site deliberately does:

* **Reserved seats, one plan.** The hall is described once, in `seating.js`, and
  the booking page, the admin pages, `seating.html` and the server's checks are all
  drawn from it. Two people can never hold the same seat: the database refuses it.
* **Accessible seats are arranged, not sold.** Sixteen seats a night are kept for
  people who need them. The public sends a request; the team books the seats.
* **No database keys in the browser.** Every read and write goes through `/api/*`,
  which holds the secrets as Vercel environment variables. Payments are confirmed
  server-side against SumUp — the browser is never trusted to say it paid.

---

## 1. What's here

```
index.html         Home — hero, countdown, live availability per night
about.html         Story, song list, characters, credits
booking.html       The booking flow (night → seats on the plan → details → SumUp)
success.html       Payment confirmation, booking reference, add-to-calendar
cast.html          Cast & crew          (content in cast.js)
photos.html        Gallery + lightbox   (content in photos.js)
games.html         Arcade games
quiz.html          Trivia bank, 10 questions per round
wall.html          Public good-luck message wall (moderated)
seating.html       The hall plan, for the public — where everything is
admin.html         Password-protected dashboard

config.js          >>> Show dates, times, venue, price — edit this first
seating.js         >>> The hall plan: rows, seats, aisles, stage, exits, toilets,
                       accessible seats — the 504 seats, and the one copy of them
seatplan.js        Draws the plan from seating.js (booking, admin, seating.html)
seatplan.css       How the plan looks, on the theme's colours
theme.css          Shared "Aegean whitewash" design system
cast.js            Cast and crew list
photos.js          Gallery image list
logo.svg           Original lettering — no MTI or ABBA artwork used
favicon.svg

api/_supabase.js       Shared PostgREST helper (no npm dependencies)
api/_email.js          Resend + Brevo senders, and the confirmation template
api/_confirmations.js  The "has this already been sent?" rule, in one place
api/_show.js           Show details the emails need (keep in sync with config.js)
api/_seats.js          Counts a night's seats: sold, held, free, accessible
api/_access.js         The two emails an access request sends, claimed once each
api/availability.js    GET  — aggregate seat counts only, no customer data
api/seats.js           GET  — which seats are unavailable for a night, and nothing else
api/access-request.js  POST — "Need accessible seating?": stores it, emails the team
api/create-checkout.js POST — holds the chosen seats atomically, opens SumUp checkout
api/verify-payment.js  POST — asks SumUp if it was paid, confirms, sends the email
api/reconcile.js       CRON — rescues abandoned payments, retries unsent emails
api/wall.js            GET/POST — message wall
api/admin.js           POST — everything behind ADMIN_PASSWORD

schema.sql         Run first in the Supabase SQL Editor — the base tables
schema-email.sql   Run second — email tracking and payment rescue
schema-seating.sql Run third — seats, holds, blocks, access requests. Every
                   database needs it, including one that already has the
                   first two. All three are safe to re-run.
tests/seat-holds.sh
                   Double-booking tests for schema-seating.sql, against a
                   throwaway local Postgres
vercel.json        Headers and routing
.env.example       The environment variables you need to set
```

---

## 2. Setting it up

### Step 1 — Edit `config.js`

Everything marked `// TODO` needs your real values:

* show dates, times and year
* venue name
* contact-form inbox (`ENQUIRIES_TO` in Vercel — defaults to smemammamia@proton.me)
* ticket price (**must match `TICKET_PRICE` in Vercel** — the server decides the price)
* the most seats in one booking (`maxPerBooking`, must match `MAX_PER_ORDER`)

There is no capacity to type in: a night has the seats in `seating.js`, less the
accessible seats not released, less any blocked in admin. See Step 3d.

The performance `key` is the ISO date and is used in URLs, in the database and in
`schema.sql`. Change it in all three or nowhere.

**Booking references** are `MM-` followed by six characters from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O, 0 or 1, so nothing is misread over the
phone or off a door list) — for example `MM-4F2K9A`. The format is generated in two
places, `config.js` for the browser and `api/_supabase.js` for the server, and
validated by a regex in `api/verify-payment.js`. If you ever change the prefix,
change it in all three. The prefix is also what keeps this show's references
distinguishable from the school's other productions on a bank statement.

### Step 2 — Supabase

1. Create a **new** Supabase project for Mamma Mia!. Do not reuse the Popstars
   project — the table names are identical and the two shows' bookings would land in
   the same rows. A fresh project is free and takes two minutes.
2. Edit the seed block at the bottom of `schema.sql` so the dates match `config.js`.
3. Paste the whole of `schema.sql` into **SQL Editor → New query** and run it.
   Then `schema-email.sql`, then `schema-seating.sql`, the same way, in that order.
4. **Settings → API** — copy the *Project URL* and the *service_role* key.

`schema-seating.sql` also takes away the anon role's right to call the booking
functions. Postgres lets everyone execute a new function unless told otherwise, and
the older files only revoked the `anon` role by name — so before it is run, anyone
holding the project's anon key could call `confirm_paid_booking` directly. Run it.

The schema turns row level security on and revokes the anon role's access to
everything, so the anon key is useless on its own. That's intentional.

### Step 3 — SumUp

In your SumUp profile, **Developers → API keys**, create a secret key, and note your
merchant code. Reusing the school's existing merchant account is the quickest route
and the payments land where they always have; a separate account keeps this show's
takings on their own statement, which is usually easier for the accounts at the end.
Decide which before sales open — see *Still to confirm* below.

Card statements and the SumUp dashboard show a short descriptor, set in
`api/create-checkout.js`: `Mamma Mia! — 2 tickets (2027-01-28)`. Keep it short; the
full billing does not fit on a card statement, and MTI's billing requirements apply
to programmes and promotional material, not to a payment descriptor.

### Step 3a — Confirmation emails

Skip this and the site works, takes money, and sends nobody anything. Do it.

**Pick a provider.** [Resend](https://resend.com) is the simplest — 3,000 emails a
month free, which comfortably covers a 1,500-seat run.
[Brevo](https://brevo.com) is the alternative at 300 a day. Set **both** and the
site fails over automatically: if one provider has a bad morning, the other picks
up without anyone noticing.

**You need a domain you control the DNS for.** This is the part people get wrong.
Gmail and Outlook quietly bin mail that isn't authenticated, so you cannot send
"from" a gmail.com address, and you cannot send from the school's domain unless
you can add DNS records to it. Options, best first:

1. A domain for the show (`mammamiathemusical.ie` or similar) — you own the DNS, done.
2. A subdomain of the school domain (`tickets.stmarysedenderry.ie`) — ask whoever
   runs the school DNS to add the three records the provider gives you.
3. The provider's shared sending domain — works, but the "via resend.dev" line in
   the from-address looks amateurish for a school production.

**Add the DNS records the provider shows you.** There are three, and all three matter:

| Record | What it does | What breaks without it |
|---|---|---|
| SPF (TXT) | says this provider may send as you | Gmail marks it spam |
| DKIM (TXT/CNAME) | cryptographically signs each email | Gmail marks it spam |
| DMARC (TXT) | tells receivers what to do with fakes | inbox placement suffers |

Start DMARC permissive — `v=DMARC1; p=none; rua=mailto:you@yourdomain.ie` — and
tighten to `p=quarantine` once you can see mail is being delivered. Verification
usually takes minutes, occasionally a few hours.

**Then set the email variables** (full list in `.env.example`):
`EMAIL_FROM`, `EMAIL_REPLY_TO`, `RESEND_API_KEY` and/or `BREVO_API_KEY`,
`CRON_SECRET`, `SITE_URL`. `EMAIL_BCC` is optional and gives the office a copy
of every confirmation.

The confirmation email carries the MTI credit and the no-recording notice in its
footer. Both are licence conditions — do not remove them when editing the template
in `api/_email.js`.

**Run `schema-email.sql`** in the SQL editor, after `schema.sql`.

### Step 3b — The reconciler

`/api/reconcile` is the safety net, and it is the difference between "usually
works" and "bulletproof". It does two things, both idempotent:

1. **Rescues abandoned payments.** If someone pays and closes the tab before the
   page confirms it, SumUp has their money and the database still says "held" —
   the hold expires and they turn up on the night with no booking. The reconciler
   asks SumUp about every abandoned checkout and confirms the ones that were
   really paid. Without this, a customer can be charged and get nothing.
2. **Retries every unsent confirmation.** Provider outage, a function killed
   mid-send, a browser that never came back — it catches all of them.

`vercel.json` schedules it hourly. **On Vercel's Hobby plan crons only fire once a
day**, which is too slow while tickets are selling. Either:

* upgrade to Pro for the run (hourly works as configured), or
* leave the daily cron as a backstop and add a free 10-minute trigger:
  [cron-job.org](https://cron-job.org) hitting
  `https://your-site/api/reconcile?secret=YOUR_CRON_SECRET`, or Supabase's own
  `pg_cron` + `pg_net` doing the same.

You can also hit **Run checks now** on the admin Overview tab any time.

### Step 3c — Accessible seating

Sixteen seats a night — J1, J2, J13–J16, J27, J28 and the same in row K, either
side of the cross aisle — are accessible seats. They are listed in `seating.js`
(`accessibleSeats`) and drawn in their own colour everywhere.

**They are not sold online.** Tapping one on the booking page, or the
*Need accessible seating?* button beside the plan, opens a short form: name, email,
phone, night, how many wheelchair spaces and how many companion seats, and notes.
A request:

* is stored in `access_requests`, before anything is emailed, so it is never lost;
* emails the team (`ACCESS_REQUESTS_TO`, else `ENQUIRIES_TO`) with Reply-To set to
  the person asking;
* sends the person a short acknowledgement that the team will be in touch.

Each of the two emails is claimed in the database before it is sent, so the
reconciler can retry a failed one without anybody getting it twice.

A wheelchair space takes the place of two seats with the chairs taken away, and a
companion sits alongside. The team works that out with the person; the site only
records which seats were used.

**In admin:** the *Access requests* tab lists every request with its status
(new, contacted, seated, closed) and a box for staff notes. *Book seats* opens Add
booking with the request filled in; pick the accessible seats, choose cash, card on
the door or complimentary, and the request is marked seated with the booking
reference on it.

**Releasing them.** On the *Seat plan* tab, *Release accessible seats to general
sale* puts chosen accessible seats on public sale for that night. It is a manual
switch — nothing releases them automatically — and it can be reversed for any seat
nobody has bought or is holding.

**Other access needs** — an aisle seat, hearing support — are still asked about on
the booking form, stored on the booking as codes, and shown on the admin Overview,
Bookings and Door list tabs, in the CSV and in the confirmation email. The wording
lives in `config.js` (browser) and `api/_show.js` (server), which must agree.
`wheelchair` stays a valid code for staff but is not offered on the public form
(`publicForm: false`), because wheelchair spaces go through a request.

### Step 3d — The seating plan

The hall is described once, in **`seating.js`** (`PLAN`), and everything else is
built from it: the plan people tap on, the seats the database will accept, the
seat numbers in the confirmation email, the admin seat plan and picker, the printed
plan, and `seating.html`. There is no second copy to keep in step.

| | |
|---|---|
| Rows | 18, lettered A to T, skipping I and O. Row A is nearest the stage |
| Seats | 28 a row, numbered 1–28 left to right as you face the stage; 1–14 left of the centre aisle, 15–28 right |
| Seat ids | `A1` … `T28` — 504 a night |
| Aisles | centre aisle full depth; cross aisle between J and K; side gangways both walls; front walkway; rear walkway |
| Stage | full width at the top, about 22.5% of the hall's depth, backstage strip behind |
| Exits | top wall right (backstage), bottom wall right corner, left wall near the back |
| Toilets | outside the left wall: female just behind the cross aisle, male near the stage |
| Accessible | 16 seats, J and K rows — see Step 3c |

The drawing is schematic, not to scale. To change it, edit `PLAN` and reload: the
booking page, admin and `seating.html` redraw, and the server validates against the
new seats. **Do not re-draw the plan once seats are sold** — seat ids already on
bookings are not moved, so dropping a row leaves somebody holding a seat that is no
longer on the map.

**How a seat is held.** `create_hold` runs in one transaction under a
per-night advisory lock. It sweeps expired holds, refuses blocked seats and
unreleased accessible seats (for the public), refuses any seat already taken —
naming it — and then inserts the booking and every seat together, or nothing. The
primary key on `booking_seats (performance_date, seat_id)` is the last line: even if
two calls ever got past the lock at once, the second insert would fail and its
whole transaction would roll back. `tests/seat-holds.sh` races holds against each
other to prove it.

**When a payment lands after its hold died.** The seats went back on sale at the
fifteen-minute mark. `confirm_paid_booking` — used by the live verifier and the
reconciler — gives the booking its own seats back if every one of them is still
free. If any has gone, the booking is still confirmed (the money is real) but with
no seats, and flagged as a **seat conflict**: it shows in red on the admin Overview
with a *Reseat* button, its confirmation email says the box office will confirm the
seats, and the door list says the same. Nobody is moved to different seats behind
their back. After reseating, *Send updated seats* emails them the new ones.

**Blocking seats.** On the *Seat plan* tab, *Block seats* takes seats off public
sale for a night — the sound desk, house seats. The public sees them as unavailable;
staff can still book them from Add booking (it asks first). A seat somebody has
cannot be blocked.

### Step 4 — Vercel

Push this folder to a **new** GitHub repo — `mamma-mia` reads well — and import it in
Vercel as a **new Vercel project**, also called `mamma-mia`, so the default
deployment URL is recognisable. Do not add these files to the other show's repo or
redeploy them into its Vercel project; they need their own environment variables
pointing at their own Supabase project. Then point your real domain at it
under **Settings → Domains**, and set the environment variables from `.env.example`
under **Settings → Environment Variables**:

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | from the **Mamma Mia!** Supabase project → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | secret — server side only, never in a page |
| `SUMUP_API_KEY` | secret |
| `SUMUP_MERCHANT_CODE` | e.g. `MABCDEFG` |
| `ADMIN_PASSWORD` | pick something long; this is the only lock on the admin page |
| `EMAIL_FROM` | `Mamma Mia! <tickets@smemammamia.com>` — a domain verified with the provider, spelled exactly as it appears there, and no quotes around the value in the Vercel box |
| `EMAIL_REPLY_TO` | where replies go |
| `ENQUIRIES_TO` | optional, where contact-form questions go — defaults to `smemammamia@proton.me`. Set in Vercel it wins over the default, so check there before assuming the code decides |
| `RESEND_API_KEY` | and/or `BREVO_API_KEY` — set both for failover |
| `CRON_SECRET` | protects `/api/reconcile` |
| `SITE_URL` | your live URL, for links inside emails — e.g. `https://mammamiathemusical.ie` (an example, not a registered domain) |
| `EMAIL_BCC` | optional, office copy of every confirmation |
| `ACCESS_REQUESTS_TO` | optional, where accessible-seating requests go — defaults to `ENQUIRIES_TO` |
| `TICKET_PRICE` | optional, defaults to 10 — must match `config.js` |
| `HOLD_MINUTES` | optional, defaults to 15 |
| `MAX_PER_ORDER` | optional, defaults to 10 — the most seats in one online booking; must match `maxPerBooking` in `config.js` |
| `WALL_AUTO_APPROVE` | optional, `true` posts wall messages without moderation |
| `SHOW_NAME` | optional, defaults to `Mamma Mia!` — shown in emails |
| `SHOW_SCHOOL` | optional, defaults to `St Mary's Secondary School, Edenderry` |
| `SHOW_VENUE` | optional, defaults to the school address with `Co. Offaly` |
| `SHOW_DOORS` / `SHOW_CURTAIN` | optional, default `7:00 PM` / `7:30 PM` |

The `SHOW_*` variables exist so the office can correct a time or a title in the
confirmation email without a redeploy. Their defaults live in `api/_show.js` and are
meant to match `config.js` — set them only when you need to override.

Redeploy after adding them — Vercel only picks up new variables on a fresh build.

### Step 5 — Check it works

1. Open `/api/availability` in a browser. You should see the seat counts as JSON —
   488 on sale a night before anything is sold or released (504 less 16 accessible).
2. Open `/admin.html`, sign in, and confirm the dashboard loads. The Overview tab
   tells you straight away whether email is configured.
3. Make a real €10 booking with your own card, then refund it in SumUp. This is the
   only way to be sure the whole chain works before you tell people to buy tickets.
   Check that the confirmation lands in your **inbox**, not spam — and try a Gmail
   address, a Hotmail address and a school address, because they filter differently.
   Check the reference on it reads `MM-` and not anything else.
4. Test the rescue path, because it is the one nobody thinks to test: start a
   booking, pay, and **close the tab the instant the payment goes through**. The
   booking will sit as "held". Hit **Run checks now** on the admin Overview tab; it
   should turn into a confirmed booking, on the seats chosen, with the email sent.
5. Send yourself an accessible seating request from the booking page. The team
   inbox and your own should each get one email, and the request should be on the
   admin *Access requests* tab.

### Step 6 — The double-booking tests

`tests/seat-holds.sh` builds a throwaway database from the three schema files on a
**local** Postgres (never the Supabase project) and checks the seat functions
directly: 25 holds racing for one seat (exactly one wins), two overlapping holds with
the first slow to commit (all or nothing, the loser told which seat), an expired hold
taken over, the late payment on it honoured and flagged, a late payment whose seats
are still free given them back, accessible and blocked seats, reseating, and that
the anon role can call none of it.

```
PGHOST=/var/run/postgresql PGUSER=postgres tests/seat-holds.sh
```

Run it after any change to `schema-seating.sql`.

---

## 3. How the booking works

```
Browser                     /api/create-checkout            Supabase        SumUp
   │  GET /api/seats?date=…  ── which seats are unavailable ───>│             │
   │  night + seat ids + details     │                          │             │
   ├────────────────────────────────>│                          │             │
   │                                 │  create_hold()           │             │
   │                                 ├─────────────────────────>│             │
   │                                 │  (per-night lock: every seat free, not │
   │                                 │   blocked, not kept-back accessible —  │
   │                                 │   then all of them held, or none)      │
   │                                 │  <── booking, held 15 min │             │
   │                                 ├────────────────────────────────────────>│
   │  <── checkoutUrl ───────────────┤                          │  checkout    │
   │                                                                          │
   │  browser is redirected to SumUp's hosted payment page ──────────────────>│
   │  <── SumUp redirects back to /success.html?ref=MM-XXXXXX ────────────────┤
   │                                                                          │
   │      /api/verify-payment                                                 │
   ├─────────────────────────────────> asks SumUp: was it actually paid? ────>│
   │                                   if PAID → confirm_paid_booking():      │
   │                                             confirmed, seats kept or     │
   │                                             given back, or flagged;      │
   │                                             confirmation email sent      │
```

**Card details never touch this site.** The browser leaves for SumUp's own hosted
checkout page and comes back to `success.html` when SumUp is finished with it. There
is no card form and no payment iframe here.

The checkout is created with `hosted_checkout: { enabled: true }`, which is what
makes SumUp return a `hosted_checkout_url` to send the customer to. That URL is the
only one that works — a checkout created without the flag has no payment page at
all. The hosted session lasts 30 minutes, comfortably longer than the 15-minute
ticket hold.

Things worth knowing:

* **The price is set on the server.** The browser sends seat ids, never an amount
  and never a ticket count: the number of seats is the number of tickets.
* **The booking reference is the thread through everything.** `MM-XXXXXX` is the
  SumUp `checkout_reference`, the database key the reconciler looks up, the subject
  line tag on the confirmation and what the customer quotes at the door.
* **Holds expire by themselves.** An unpaid hold stops blocking its seats after 15
  minutes; the next booking for that night sweeps them back on sale.
* **If somebody took a seat while the customer was deciding,** the booking page is
  told which one, greys it out, keeps the seats that are still free selected, and
  asks them to pick again.
* **The confirmation email goes the moment the payment is confirmed.**
  `/api/verify-payment` waits for the email provider before it answers, so the
  customer normally has the email in hand while `success.html` is still on screen.
  It tries twice before giving up and leaving it to the reconciler.
* **Exactly one email, however many times it is asked for.** `success.html` verifies
  up to four times, the reconciler runs on a schedule and an admin can hit resend —
  a database-level claim means the customer still gets exactly one email.
* **Access requirements are asked for, not guessed at.** The details step asks the
  question, unticked by default. What comes back is on the booking from the moment
  the hold is created — so it survives an abandoned payment being rescued — and it
  is on the printed door list for front of house.
* **A failed email never costs anyone their booking.** The booking is confirmed
  first; the email is attempted after, and retried until it goes.
* **If SumUp took the money, the booking gets honoured** — even if its seats were
  taken while the customer was away. It is flagged as a seat conflict on the admin
  Overview so the office can reseat the party, rather than the customer discovering
  it at the door. See Step 3d.

---

## 4. Running the show

**Before tickets go on sale**

* Set the real dates in `config.js`, then hit *Sync from config.js* on the admin
  Settings tab.
* Block the sound desk and any house seats on the *Seat plan* tab, for each night.
* Put the cast into `cast.js` and rehearsal photos into `photos.js` and `/images`.

**While selling**

* *Overview* — per night: seats sold, holding and free; accessible seats assigned
  and still kept back; open access requests; and any **seat conflicts** in red, with
  a *Reseat* button. Also how much is taken, by whom, and how many complimentary.
* *Access requests* — work through them: call, note it, *Book seats*, mark the status.
* *Bookings* — every booking with its seats. *Move* puts a party in other seats;
  *Send updated seats* then emails them. *Cancel* is for mistakes — there are no
  refunds, and cancelling something paid online asks you to confirm that.
* *Add booking* — cash, card on the door, or complimentary, on any seat you pick:
  accessible and blocked included. Confirmed at once, emailed if there is an address.
* *Seat plan* — who is where; block or unblock seats; release accessible seats to
  general sale or keep them back again.
* *Settings* — the seats on sale per night, worked out from the plan; close a night.

**On the night**

* *Door list* — alphabetical by name, with seats, a tick box, and an ♿ note against
  anyone who asked for help. People who were passed a ticket give the booking name
  or the reference.
* *Seat plan → Print with names* — the whole hall on one landscape page with a
  surname in every seat taken, and the full who-sits-where list on the next.
  Print both before doors.
* Make the no-recording announcement before curtain — it is a licence condition, not
  a courtesy.

**Afterwards**

* *Bookings → CSV* gives you the lot for the accounts.

---

## 5. Licensing

*Mamma Mia!* is licensed through **Music Theatre International (MTI)**. The terms
below come with the licence. They are not house style and they are not negotiable at
school level — read them before anything is printed or posted.

**The credit, verbatim.** This must appear on all programmes, posters and
promotional material, exactly as written:

> Mamma Mia! is presented through special arrangement with Music Theatre
> International (MTI). All authorized performance materials are also supplied by MTI.
> 423 West 55th Street, New York, NY 10019.

**The recording notice, verbatim:**

> The videotaping or other video or audio recording of this production is strictly
> prohibited.

Both lines appear in the footer of the confirmation email (`api/_email.js`) and
should appear in the public page footers and on the About page. Leave them in place.

**Other restrictions the school needs to know about:**

* **No "Bride" artwork.** Amateur licensees may not use the well-known Broadway
  "Bride" logo or key art.
* **No ABBA name in logos.** The ABBA name may not be referenced in the show's logo
  or logo treatments.
* **Original designs only.** Choreography, direction, staging, and set and costume
  designs from previous productions — professional or amateur — may not be reused.
  The school's production must be originally designed and staged.
* **Billing sizes are specified by MTI.** The licence sets the relative type sizes
  for Benny Andersson and Björn Ulvaeus, Stig Anderson, Catherine Johnson (book),
  Judy Craymer (original concept) and Martin Koch (additional material and
  arrangements). Follow the billing sheet in the MTI production pack exactly when
  laying out posters and programmes; do not eyeball it.
* **Minimum cast size is 20.**

The artwork on this site (`logo.svg`, `favicon.svg`, and the whole "Aegean
whitewash" colour scheme) is original and uses neither MTI key art nor the ABBA
name. If the MTI production pack includes promotional artwork the school is cleared
to use, drop it into `/images` and swap it in — but confirm the clearance with MTI
first, and never lift artwork from the MTI website or from another production's
posters.

The song list on the About page follows the standard licensed edition. Check it
against your own score, since the running order differs between versions.

---

## 6. Still to confirm

Open items before tickets go on sale. Everything here has a working placeholder in
the code, so the site runs — but each one needs a real answer from the school.

| # | Item | Where it lives |
|---|---|---|
| 1 | **Doors and curtain times.** Currently 7:00 PM / 7:30 PM. | `config.js`, `api/_show.js` (and `SHOW_DOORS` / `SHOW_CURTAIN` if overridden) |
| 2 | **504 seats per night** — check it against the hall's fire cert before selling to it. | `seating.js` |
| 2a | **Fire officer sign-off on the seating plan.** The plan on the site is schematic, not to scale; 14 seats between the centre aisle and a side gangway, a cross aisle after row J, exits as drawn. The sign-off is somebody else's. | `seating.js`, `seating.html` |
| 3 | **SumUp merchant account** — reuse the school's existing one, or open a new one for this show? | `SUMUP_API_KEY`, `SUMUP_MERCHANT_CODE` in Vercel |
| 4 | **Contact form.** Questions go through `contact.html` → `/api/enquiries`, emailed to `smemammamia@proton.me`. Needs email set up (Step 3) to work; shares the provider's daily sending cap with confirmations. | `ENQUIRIES_TO`, `EMAIL_REPLY_TO` in Vercel |
| 5 | **Artwork and logo treatments.** Confirm with MTI exactly which artwork and logo treatments the school may use — the "Bride" art and the ABBA name are out, so check what is in. | `logo.svg`, `favicon.svg`, `/images`, and anything going to print |

Item 1 is marked `// TODO` in `config.js`. Date changes made in `config.js` need
*Sync from config.js* on the admin Settings tab to reach the database.

---

## 7. Things that will bite you

* **Pointing this deployment at the other show's Supabase project.** Same table names,
  two shows, one set of rows — capacity, door lists and takings all wrong, and no
  clean way back. Separate repo, separate Vercel project, separate database.
* **`TICKET_PRICE` and `config.js` disagreeing.** The page shows one price, the
  server charges another. Set both.
* **Re-drawing the seating plan after tickets have sold.** Seat ids already on
  bookings are not moved. Take out a row and somebody is holding a seat that is no
  longer on the map, and will not find it on the night.
* **Not running `schema-seating.sql`.** Every booking fails with *Could not reserve
  your tickets*, and the booking functions stay callable with the anon key.
* **Leaving seat conflicts on the Overview.** Each one is a paid party with no
  seats. Reseat them and press *Send updated seats* well before the night.
* **Adding a performance date in `config.js` but not the database.** The night shows
  on the site, then booking fails with "that performance does not exist". Run *Sync
  from config.js*.
* **Blocking or keeping back seats somebody has.** Refused — move or cancel that
  booking first.
* **Dropping `hosted_checkout.enabled` from the SumUp payload.** Checkout creation
  still succeeds and still returns an id, so nothing looks wrong from here — but
  SumUp builds an API-only checkout with no payment page behind it, and the customer
  lands on "There's nothing here" at `checkout.sumup.com`. The payment page URL
  always comes back as `hosted_checkout_url`; never construct one from the checkout
  id, because there is nothing at that address.
* **`ADMIN_PASSWORD` is the whole security model for the admin page.** Anyone with it
  can see every customer's name, email and phone number. Treat it accordingly.
* **Sending from an unverified domain.** Everything looks fine — the API accepts the
  send, the admin page says "Sent" — and the mail lands in spam or nowhere. Verify
  the domain and add all three DNS records before you announce ticket sales.
* **Pasting an environment variable with its quotes.** `.env.example` quotes
  `EMAIL_FROM` so the file parses as a shell `.env`; the Vercel box stores whatever
  you type, quotes included, and `"Mamma Mia! <tickets@…>"` is not an address. The
  site now strips one layer of wrapping quotes, but check the value anyway. If the
  contact form answers 502, post `{"password":"…","action":"email-check"}` to
  `/api/admin` — it names the setting at fault and, with `"to":"you@example.ie"`
  added, sends a test and hands back the provider's own words.
* **Leaving `CRON_SECRET` unset.** `/api/reconcile` refuses every request without
  it, so the hourly cron answers 503 forever: no abandoned payment is rescued and no
  unsent confirmation is retried. The Vercel log shows the run finishing in under
  100ms with no outgoing requests — that shape is the giveaway. Set it, redeploy,
  then hit **Run checks now** on the admin Overview tab to clear the backlog.
* **Leaving the reconciler on a daily schedule.** It still works, but someone whose
  payment needs rescuing waits up to 24 hours to find out they have a ticket. Use a
  10-minute trigger while sales are open.
* **`SHOW_DOORS` / `SHOW_CURTAIN` drifting from `config.js`.** The website would show
  one time and the confirmation email another. `api/_show.js` carries the defaults —
  if you change times, change them in both places.
* **Printing anything before checking the billing sheet.** MTI specifies credit
  sizes; a poster that gets them wrong has to be reprinted.
