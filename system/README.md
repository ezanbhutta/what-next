# XStudioz management hub

One place for the whole Fiverr operation. Deployed at **system.xstudioz.com**
as a Hostinger Web App (Node 22), auto-deployed from this repo's `main`.

## The rule that shapes everything

**This hub reads. It does not change anything that already exists.**

No Google Sheet is written to. No existing app, database, Vercel project or
Apps Script is modified. The four apps already running — CSR Pulse, CSR
Inquiries, the impressions tracker and the shift logger — keep working
exactly as they do today. If this hub breaks, nothing else notices.

That is not caution for its own sake. It is what makes the hub useful:

> There are five systems that each hold a third of the truth, and they
> disagree. A sixth participant would make it worse. A referee makes it
> better.

The finding that proved it: joining 1,053 orders against 319 logged inquiries
on Fiverr username showed **25 buyers marked "Not Placed" who actually
ordered** — 27 orders worth $3,628 — plus 5 marked won with no order behind
them. Real conversion is 29.4%, not the 22.9% the sheet reports. Nobody knew,
because the CSR who logs the inquiry on Monday never sees the order land on
Thursday.

## Where data comes from

```
Python growth engine  ──►  data/*.json  ──►  hub reads from disk
   (runs daily, elsewhere)   committed        (never recomputes)

hub's own forms       ──►  MySQL         ──►  only what a human typed
```

Two stores, one job each:

- **`data/`** — everything computed: orders, inquiries, revenue, health,
  money-at-rest, client history. Produced by the engine, versioned in git,
  read-only to this app. Deploying is how it refreshes.
- **MySQL** — everything typed: checklist ticks, the daily metrics form,
  team scores, client notes, the response library, the talk playbook, upsell
  pipeline.

No figure exists in both. A second copy of a number is a second thing that
can be wrong, and this repo exists because that already happened.

## The join key

`buyer` — the Fiverr username (`thisguy07`, `nativ_shaibi`, `dcleanglobe`).

It is the only identifier that is stable, unique and present on both sides.
Orders and inquiries both carry it; the message templates already use it as
`{username}`. Every table here that refers to a client keys on it.

Profile names are the *other* join key, and they are messier — five systems
use four incompatible name sets. The engine canonicalises them
(`xstudioz/contracts.py:normalise_profile`); the hub trusts that and does not
invent a second mapping.

## Stack

Node 22 · Express · MySQL (`mysql2`) · server-rendered HTML · no bundler.

Server-rendered on purpose. Every one of the four existing apps is
browser-side, so the database key has to ship inside the JavaScript — which
is how a real password ended up readable by anyone who opened devtools. Here
the credentials never leave the server and there is no bundle to read them
out of. It removes the whole class of problem rather than guarding against
it.

## Layout

```
server.js          express app, routing, session
lib/db.js          mysql pool
lib/auth.js        login, session cookie
lib/data.js        reads data/*.json from the engine
lib/reconcile.js   the referee: where the sheets disagree
lib/handbook.js    parses the owner's six documents out of data/handbook/*.txt
db/schema.sql      MySQL DDL — only human-entered state
views/             one module per section, server-rendered
public/app.css     the design system
data/              engine output, committed
tests/wiring.js    the seam: routes exist, loaders feed their views
```

### The seam between `server.js` and `views/`

A view is written against `ctx.data`; `server.js` decides what goes in it. The
two are edited separately and they drift, and the drift is invisible: a view
handed nothing takes the branch written for "there is nothing here yet" and
renders a calm, correct-looking page that is missing half of itself. HTTP 200,
no error in the log, nothing to notice. `tests/wiring.test.js` runs every
loader against a stub database and fails if a view reads a key its loader never
sets — and separately, if a link or form a view emits points at a route nobody
registered. Run it before believing a section works because it loaded.

## Sections

| Route | Question it answers |
|---|---|
| `/` Today | What do I do now, and who owns it |
| `/entry` Reach | What Fiverr showed, read from the impressions board |
| `/inquiries` | Who asked, who converted, which CSR, which shift |
| `/orders` | What is live, what stage, what is late |
| `/clients` | One record per buyer — history, value, notes |
| `/messages` | What this buyer was already told, and what to say next |
| `/responses` | The reply library, searchable |
| `/team` | Weekly 1–5 scoring, self vs manager, promises kept |
| `/money` | Revenue, money sitting still, upsell pipeline |
| `/reports` | My shift: what is due on this profile, and logging what happens |
| `/reports/ceo` | What the shifts produced, and what they left owed — manager and owner only |
| `/handbook` | The six owner-written documents, searchable across all of them |

### Messages, and the order it is in

Messages is the only section that hands somebody a sentence to send, which
makes it the only one that can do damage by being read correctly. So the page
is ordered: who this buyer is, then the triage, then what may be sent today,
and only then the words.

The words are Ezan's own Client Talk Hub, in the `talk` table. A card is a
situation, a turn inside it is one exchange: what the buyer says, and the line
that goes back with `{username}` filled in. A CSR browses by group (questions
to ask, upgrade moments, when they say no, handle these carefully) and by stage
(before the order, order starts, while working, they approve, after delivery).
Both are links, so the state of the page is in its URL and one CSR can send
another the exact view they are looking at.

Three things about it are load-bearing:

- **The triage comes first.** An open order is three different problems. We
  owe work, they owe a reply, or it is dead, and the same sentence is right for
  one and damaging for another. A "just checking in" note to a buyer who is
  waiting on us is a timestamped admission that we have not started.
- **A review ask is refused out loud.** Any line that asks for one is shown,
  marked, and refused with the order and its age printed, whenever the buyer is
  late or cold. It is not silently dropped: a line that quietly disappears gets
  written from memory next time, and gets it wrong. `reviewGate()` fails
  CLOSED: an unreadable engine run is "we cannot see what is late", never
  "nothing is late".
- **Ezan edits it, not a deploy.** Add, edit and switch off are owner only,
  checked in the route rather than by hiding the form. Cards are switched off,
  never deleted, because a card that went out for six months is the explanation
  for six months of replies.

`db/seed-talk.js` loads the starting set out of `db/client-talk-hub.html`, his
own working page, parsed rather than copied into a second format that could
disagree with it.

### Reports, in two halves

One rail entry, one section lock, one set of tables, two pages — because "log
my shift" and "read what the shifts produced" are two jobs, not two modes of
one. It replaces the standalone shift logger, whose Supabase anon policy was
`using (true)` on every table with the publishable key inside the browser
bundle: anyone who opened devtools could delete every report the team had ever
filed. Here every write is a server-side POST through `auditedWrite`.

The thirteen reminder logics live in `lib/reminders.js`, ported from the
owner-written `REMINDER-LOGICS.md`. Two things about them are load-bearing:

- **A reminder belongs to the profile, not the person.** It pops for whoever is
  covering that profile when it falls due, on any shift.
- **Reminders are booked in the same transaction as the activity that caused
  them.** If the booking fails the entry rolls back with it. An entry that
  saved and booked nothing is invisible from the outside — the CSR sees
  "saved", the timeline shows the entry, and the buyer is simply never
  contacted again. That failure is the reason this feature exists.

House rule 5 meets the spec's rule 5 here. Rule 5 books a public-review ask
thirty minutes after an order completes; where the buyer has a stale order or a
standing frustrated/disputed caution, **nothing is booked at all** — a
suppression, not a delay. The CSR page holds the ask a second time for buyers
flagged after it was booked, and records that close as `held_no_ask` so the
owner's page can count how often the rule fired.

## Local development

```bash
npm install
cp .env.example .env      # fill in your MySQL details
npm run migrate           # creates the tables
npm run seed              # the team, and the reply library
npm run seed:talk         # the owner's Client Talk Hub into `talk`
npm start                 # http://localhost:3000
```

Both seeds are safe to run again. `seed:talk` keys on a stable slug, so a
second run inserts nothing, and cards written inside the hub are invisible to
it — re-importing the owner's file can never overwrite what he typed here.

## Deploying

Hostinger auto-deploys `main`. Environment variables live in the Web App's
**Environment variables** panel, never in this repo:

```
DB_HOST  DB_PORT  DB_NAME  DB_USER  DB_PASSWORD
SESSION_SECRET      long random string
APP_PASSWORD        what the team types to get in
```

`.env` is gitignored. If you ever find a credential in a commit here, rotate
it — do not just delete the line.

## House rules

1. Never write to a Google Sheet. Read only.
2. Never fabricate a number. Missing is `MISSING`, not `0`.
3. A rate with a small denominator is shown as a **range**, never a point.
   4 of 34 is `4.7%–26.6%`, and that interval contains both "crisis" and
   "nothing happened".
4. The retired volume programme is never named in any output. Columns are
   `directed_*`.
5. Never attach a review request to a late or cold order.
6. Dark mode is an explicit toggle. `prefers-color-scheme` must never flip
   the palette — that shipped once and gave everyone with a dark laptop a
   dark page they had not asked for.
