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
  team scores, client notes, the response library, upsell pipeline.

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
db/schema.sql      MySQL DDL — only human-entered state
views/             one module per section, server-rendered
public/app.css     the design system
data/              engine output, committed
```

## Sections

| Route | Question it answers |
|---|---|
| `/` Today | What do I do now, and who owns it |
| `/entry` Daily entry | Type what Fiverr showed today |
| `/inquiries` | Who asked, who converted, which CSR, which shift |
| `/orders` | What is live, what stage, what is late |
| `/clients` | One record per buyer — history, value, notes |
| `/messages` | What this buyer was already told |
| `/responses` | The reply library, searchable |
| `/team` | Weekly 1–5 scoring, self vs manager, promises kept |
| `/money` | Revenue, money sitting still, upsell pipeline |

## Local development

```bash
npm install
cp .env.example .env      # fill in your MySQL details
npm run migrate           # creates the tables
npm start                 # http://localhost:3000
```

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
