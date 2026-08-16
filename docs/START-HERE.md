# Start here

Three jobs. About 25 minutes total. You only ever do them once.

After that the system runs on its own every morning and you just read the brief.

You do **not** need to write any code. Every step is copy, paste, click.

---

# Job 1 — Let the system read your sheets by itself

**Time: 15 minutes. This is the important one.**

Right now the system can only see data that a person hands it. This job connects
it directly to your Google Sheets so it fetches its own data every morning.

### Step 1 — Make a new script

1. Go to **script.google.com**
2. Click **New project** (top left)
3. At the top, click where it says *Untitled project* and rename it to
   `XStudioz Snapshot`

### Step 2 — Paste in the code

1. You'll see a code box with a few lines in it (`function myFunction() {}`)
2. **Select all of it and delete it.** The box should be empty.
3. Open this file from your repo: `automation/Snapshot.gs`
4. Copy **everything** in it
5. Paste it into the empty box
6. Press **Ctrl+S** (or Cmd+S on Mac) to save

### Step 3 — Create the password

At the top of the screen there's a dropdown that says **Select function** or
shows a function name.

1. Click it and choose **`generateToken`**
2. Click **▷ Run**
3. Google will ask for permission. Click **Review permissions** → pick your
   account → click **Advanced** → **Go to XStudioz Snapshot (unsafe)** → **Allow**

> "Unsafe" just means Google hasn't reviewed your own private script. It's your
> script reading your own sheets. This is normal.

4. At the bottom a panel opens showing a line like:

```
SNAPSHOT_TOKEN = 3f9a2c8e...
```

5. **Copy that long code and paste it somewhere safe.** You need it in Job 2.
   Treat it like a password.

### Step 4 — Check it can see everything

1. In the same dropdown, choose **`testSnapshot`**
2. Click **▷ Run**
3. Look at the panel at the bottom. You should see a list like:

```
  [crm_orders] Nov 2025 — 105 rows, 23 cols
  [daily_flow] Daily Summary — 224 rows, 8 cols
  [impressions] Impressions — 94 rows, 7 cols
  ...
  payload: ~430 KB
```

**What to look for:** any line that says `[unknown]`. That means the system
can't tell what that tab is and will ignore it. If it's an important tab, tell
me its name and I'll fix it. If it's a scratch tab, rename it with an underscore
at the front (`_scratch`) and it gets skipped cleanly.

### Step 5 — Publish it

1. Top right, click **Deploy** → **New deployment**
2. Click the **gear icon ⚙** next to "Select type" → choose **Web app**
3. Fill in:
   - **Description:** `snapshot v1`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
4. Click **Deploy**
5. Copy the **Web app URL**. It looks like
   `https://script.google.com/macros/s/AKfy..../exec`
6. **Save that URL** next to your token. You need both in Job 2.

> **"Anyone" sounds scary — it isn't.** Without the token the page returns
> `{"error":"unauthorized"}` and nothing else. It has to be "Anyone" because the
> other option makes Google show a login page, and a computer can't log in.

### Step 6 — Make it run every morning

1. In the function dropdown, choose **`installDailyTrigger`**
2. Click **▷ Run**
3. You should see: `daily trigger installed for 01:00-02:00 UTC`

Done. Your sheets now export themselves every night, before the system wakes up.

---

# Job 2 — Tell the system where to look

**Time: 1 minute.**

You have two things from Job 1: a **URL** and a **token**. The system needs both.

There are three ways to hand them over. **Pick one.** Option A is easiest and
needs no menu hunting.

---

## Option A — Just send them to me (recommended)

Paste the URL and the token into our chat and say "put these in the routine".

I store them in the daily Routine's own configuration, which lives in your
Claude account. The morning run reads them from there before it starts.

**Why this works:** the container the system runs in is wiped and rebuilt every
day, so anything not saved somewhere permanent is lost. The Routine config is
permanent.

**Is that safe?** The token only lets someone read a copy of your sheets — it
cannot write to them, cannot touch Fiverr, and cannot spend money. It sits in
your own Claude account. If you ever want to invalidate it, re-run
`generateToken` in Apps Script and the old one stops working instantly.

If you would rather not paste it in chat, use Option B or C.

---

## Option B — Environment variables

If your Claude Code environment has a settings page with environment variables,
add these two there:

| Name | Value |
|---|---|
| `XSTUDIOZ_SNAPSHOT_URL` | the `/exec` URL from Job 1 step 5 |
| `XSTUDIOZ_SNAPSHOT_TOKEN` | the long code from Job 1 step 3 |

Look under the environment settings for this project at **claude.ai/code**.
Environments are created and configured there, and the docs are at
<https://code.claude.com/docs/en/claude-code-on-the-web>.

If you cannot find it, do not hunt for it. Use Option A instead — the result is
identical.

---

## Option C — Skip it entirely

**The system already works without this.**

Job 1's daily trigger writes a fresh snapshot into a Google Drive folder called
**XStudioz Engine Snapshots** every night. If you skip Job 2, the daily brief
still runs — it just uses the most recent snapshot it already has, and it tells
you plainly at the top how old that data is instead of pretending it is current.

Job 2 is what turns "reads yesterday's copy" into "fetches this morning's".
Worth doing, but not urgent, and nothing breaks while it waits.

---

**How you will know it worked:** tomorrow's brief says `[snapshot] fetched live`
instead of `[snapshot] using disk`.

# Job 3 — Already done. Do not redo it.

**Nothing to do here.** The team reads **system.xstudioz.com**, the hub on
Hostinger. It is live, password-gated, and it redeploys itself every time the
daily run pushes to `main` — measured at 41 seconds from push to live.

This section used to walk you through putting a second copy of the brief on
Vercel behind its own password. **Do not do that, and do not follow those steps
if you find them in an older copy of this file.**

Two reasons, in order:

1. **It leaked.** The password gate rendered the whole brief inside a hidden
   `<div>` and served it to anyone who asked. `curl` returned every client name
   and every revenue figure without ever logging in. The site was retired on
   2026-08-05 and `site/` was deleted, so the first command in those steps
   (`cd site`) now fails anyway.
2. **Two copies of the same numbers is worse than one**, even when both work.
   Two things to keep in sync, two passwords to hand out, two places to leak
   from.

`test_the_published_site_stays_retired` fails if the code comes back, and
`test_docs_do_not_teach_the_retired_publish_path` fails if any document starts
handing out the command again. That second test exists because these
instructions outlived the thing they described by six days — the guard was on
the filesystem while the recommendation sat here in prose, and nobody reads a
passing test suite for permission.

**Where the brief lives now:** system.xstudioz.com for the team, and the Claude
artifact (one private URL, republished each morning) for you and Ezan.

---

# One more thing, and it matters most

**Impressions are the number that decides what to fix.**

The engine has them: today's run holds 2,657 impression rows. This section used
to say it had none, which was wrong, and the mistake is worth keeping on the
page because it cost two days.

**The impressions workbook has two tabs and only one is dead.** `Impressions
Daily Data Sheet Profiles` stops on 13 December 2025. `Daily Data Sheet
Profiles` is current — thousands of rows, September 2025 to now. Only the first
was looked at, so the whole source was declared dead and refused every morning
while the live tab sat right beside it.

So there are two faces of one source, and both are wanted:

- **The board** (impressions-hmi) is what `/entry` shows the team, on Ezan's
  instruction from 2026-08-07. It is the corrected copy — when the sheet held a
  duplicated 5-Aug of 10,096/262, the board already had 10,455/256.
- **The sheet** is what the engine ingests, for the reach-versus-conversion
  diagnosis below.

Both appear on `/feeds` as separate rows deliberately. A gap between
"Impressions sheet (engine)" and "Impressions board" means the import has
stalled, and one merged row would hide exactly that.

Impressions are the single most important number in the system: they say
whether Fiverr is showing your gig to people again. Without them the system can
tell you organic orders fell. It **cannot** tell you whether that's because:

- fewer people are seeing the gig, that's a **ranking** problem
- people see it but don't click, that's a **thumbnail/title/price** problem
- people click but don't buy, that's a **gig page** problem

Those three need completely opposite fixes. Guessing between them wastes weeks.

**What to do:** keep the Daily Data Sheet filled in, one row per profile per day
from Fiverr Analytics. The board is fed from it, so filling the sheet updates
both.

As of 2026-08-11 its newest row is **2026-08-06** — five days behind, and
`/feeds` reports it STALE. That is the only thing on the whole board that needs
a person rather than a fix, and the P0 organic task is blocked behind it.

**Do not retire the sheet again.** Deleting a source from `config/sources.yml`
does not stop it being read: tables are matched by header fingerprint, so an
unclaimed sheet falls through to the next rule that fits. This one carries its
own organic and directed order columns, so unclaimed it is read as the daily
ledger and **doubles every order in it**. `RETIRED_FINGERPRINTS` in
`xstudioz/ingest.py` route it rather than refuse it, and
`test_impressions_table_does_not_double_count_as_flow` caught exactly that hole
being reopened.

Once 28 days in a row exist and the engine can read them, every morning's brief
will tell you which of those three it is, automatically, in plain English.

---

# What happens after that

Every morning at 07:13 Pakistan time, without anyone doing anything:

1. Your sheets export themselves (01:00 UTC, from Job 1)
2. The system reads them, checks its own maths, and writes the brief
3. It updates the dashboard and pushes the team page
4. You get a phone notification
5. Everyone opens their own list and works it

**Your only ongoing job is 30 minutes a week:** look at which predictions were
wrong, and tell me why you think they were wrong. That's the part that makes it
smarter, and it's the part I can't do alone.

---

# If something breaks

| You see | What it means | Fix |
|---|---|---|
| `snapshot endpoint returned HTTP 302` | Step 5 wasn't set to "Anyone" | Redeploy with access = Anyone |
| `{"error":"unauthorized"}` | Token doesn't match | Re-run `generateToken`, update the env var |
| `SNAPSHOT_TOKEN is not set` | You deployed before Step 3 | Run `generateToken`, then redeploy |
| `[snapshot] using disk` | Live fetch didn't happen | Check both env vars are set |
| A tab missing from the brief | It classified as `unknown` | Run `testSnapshot`, tell me the tab name |
| `[BLOCK]` in the output | The system doesn't trust its own answer | It will say why. Send it to me. |

Anything else — paste what you see and I'll sort it.
