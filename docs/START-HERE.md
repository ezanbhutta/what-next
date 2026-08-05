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

# Job 3 — Put the dashboard where your team can see it

**Time: 5 minutes. Optional — skip it if only you and Ezan need the page.**

This puts the daily brief on a web address with a password, exactly like
CSR Pulse.

1. Open a terminal in the repo
2. Run:

```bash
cd site
vercel link
```

Follow the prompts (pick your account, create a new project, call it
`xstudioz-brief`).

3. Set the password your team will type:

```bash
vercel env add APP_PASSWORD production
```

Type the password when it asks.

4. Set a security key (any long random text — mash the keyboard):

```bash
vercel env add SESSION_SECRET production
```

5. Deploy once:

```bash
vercel --prod
```

Done. From now on the page updates itself every morning — the system rewrites
the file and pushes it, and Vercel republishes automatically.

---

# One more thing, and it matters most

**The engine has no impressions at all.**

The impressions sheet stopped on 12 December 2025 and was retired on 5 August
2026. Those numbers are typed into the hub's Daily entry now. Nothing reads
that table back into the engine yet, so the brief says "no impression data"
and will keep saying it until someone builds the reader.

Impressions are the single most important number in the system: they say
whether Fiverr is showing your gig to people again. Without them the system can
tell you organic orders fell. It **cannot** tell you whether that's because:

- fewer people are seeing the gig, that's a **ranking** problem
- people see it but don't click, that's a **thumbnail/title/price** problem
- people click but don't buy, that's a **gig page** problem

Those three need completely opposite fixes. Guessing between them wastes weeks.

**What to do:** type the daily numbers into the hub's Daily entry, one row per
profile per day from Fiverr Analytics. Do not reopen the old sheet. The engine
refuses its tables now, and two places holding the same number is the problem
the hub was built to end.

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
