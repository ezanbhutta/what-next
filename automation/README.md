# Daily intake — setup

Fifteen minutes, once. After this the engine gets fresh data every morning
without anyone touching a connector, uploading a file, or remembering anything.

## What you are building

```
        ┌─ Apps Script timer (01:00 UTC) ──▶ Drive folder ──┐
Sheets ─┤                                                   ├─▶ engine ─▶ brief + dashboard
        └─ Apps Script web app  ◀── HTTPS ── daily run ─────┘
```

Two independent producers of the same snapshot. Either can fail on a given
morning; the engine takes whichever is newer. That is the "belt and braces" part
— a single path would mean one bad morning stops the whole system.

The script is **read-only** on your existing sheets. It opens them and reads
values; it never writes back.

---

## 1. Create the script project

1. Go to <https://script.google.com> → **New project**.
2. Name it `XStudioz Snapshot`.
3. Delete the stub `Code.gs` contents and paste in all of `automation/Snapshot.gs`.
4. Save.

## 2. Generate the access token

In the editor, pick `generateToken` from the function dropdown and **Run**.
Grant the permissions it asks for on first run.

Open **View → Logs**. It prints something like:

```
SNAPSHOT_TOKEN = 3f9a...c21e
```

Copy that value. It is now stored in the project's Script Properties, and it is
the only thing standing between the internet and your data — treat it like a
password. Do not commit it.

## 3. Check what the engine will see

Run `testSnapshot` and open the logs. You should get a line per tab:

```
  [crm_orders] Nov 2025 — 105 rows, 23 cols
  [daily_flow] Daily Summary — 224 rows, 8 cols
  [funnel] Dec — 81 rows, 30 cols
  ...
  payload: ~430 KB
```

**Look for `unknown`.** A tab classified `unknown` is one the engine will
ignore. If it carries signal, add a fingerprint to `ROLE_RULES` near the top of
the script. If it is a scratch tab, rename it with a leading underscore
(`_scratch`) and it will be skipped cleanly.

## 4. Deploy the web app

1. **Deploy → New deployment → Web app**.
2. Description: `snapshot v1`.
3. **Execute as:** Me.
4. **Who has access:** Anyone.
5. Deploy, then copy the `/exec` URL.

> "Anyone" sounds alarming and is fine here: the endpoint returns
> `{"error":"unauthorized"}` without the token. Access must be "Anyone" because
> "Anyone with a Google account" issues a login redirect that a script cannot
> follow.

Test it in a browser — without the token you should get the unauthorized JSON,
and with `?token=YOUR_TOKEN` appended you should get the real payload.

## 5. Install the daily timer

Run `installDailyTrigger` once. It fires `writeDailySnapshot` between 01:00 and
02:00 UTC — ahead of the Claude Routine at 02:13 UTC, so a file is already
waiting if the live fetch fails. Snapshots land in a Drive folder called
**XStudioz Engine Snapshots**, one per day, pruned after 60 days.

## 6. Tell the engine where to look

Wherever the engine runs, set:

```bash
export XSTUDIOZ_SNAPSHOT_URL="https://script.google.com/macros/s/AKfy.../exec"
export XSTUDIOZ_SNAPSHOT_TOKEN="3f9a...c21e"
```

Then:

```bash
python3 scripts/daily_run.py
```

You should see `[snapshot] fetched live, generated ...` on stderr. If the URL
is unset the engine silently falls back to on-disk snapshots, then to the old
markdown exports — "not configured yet" is not treated as an error.

For the Claude Routine, add these two as environment variables on the
environment in your Claude settings.

---

## 7. Create the missing sheet

Run `createMissingSourceSheets` once. It creates one workbook with the exact
headers the engine already reads, plus dropdown validation on the categorical
columns. The log prints its file id. Paste that into `SOURCES` at the top of
the script, then share the sheet with the team.

### Impressions live in the hub now

There used to be an impressions sheet here. It was retired on 2026-08-05: the
daily numbers are typed into the hub's Daily entry instead, and this script no
longer serves the workbook. Do not add it back to `SOURCES`. The engine refuses
every table belonging to a retired sheet (`RETIRED_ROLES` in
`xstudioz/ingest.py`) and reports the count of what it refused, so a sheet that
reappears shows up in the brief rather than quietly doubling the ledger.

The classification rules for those tabs are still in `ROLE_RULES` on purpose. A
returning tab has to arrive wearing its own name: the impressions sheet carries
its own organic and directed order columns, so with no rule to claim it first
it lands on the daily ledger and doubles every order in it.

### Disputes & dead orders

| Date | Client Name | Order Amount | Dispute Type | Status | Opened On | Resolved On | Amount Refunded | Root Cause | Notes |
|---|---|---|---|---|---|---|---|---|---|

`Dispute Type` and `Root Cause` are dropdowns — keep them. The engine watches
for a *concentrated* root cause: when one cause accounts for ≥35% of disputes
across 3 or more, that is a process defect rather than bad luck, and it emits
a task naming the specific process to change.

**Backfill what you can remember.** Even 10 historical rows makes the root-cause
concentration test meaningful.

---

## Adding another source later

1. Add `{ id: 'name', fileId: '...' }` to `SOURCES`.
2. If its tabs need a new role, add a fingerprint to `ROLE_RULES` and a matching
   alias table in `xstudioz/ingest.py`.
3. Add a drift test in `tests/test_engine.py`.
4. `python3 -m pytest tests/ -q` — everything green before it goes live.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `snapshot endpoint returned HTTP 302` | Access is not set to "Anyone". Redeploy. |
| `{"error":"unauthorized"}` | Token mismatch. Re-run `generateToken`, update the env var. |
| `SNAPSHOT_TOKEN is not set` | You deployed before running `generateToken`. |
| `snapshot is not valid JSON` | Usually a Google sign-in page — same as the 302 case. |
| `schema_version 2, engine understands 1` | The script is newer than the engine. Pull the repo. |
| A tab is missing from the brief | It classified as `unknown`. Run `testSnapshot` and check. |
| `cannot open "<id>"` | `fileId` still empty in `SOURCES`, or not shared with you. |
| `[retired] refused N table(s)` | A sheet the hub replaced is still being served. Take it out of `SOURCES`. |

## Security

- The token is a bearer secret in a URL. Rotate it with `generateToken` if it
  ever lands somewhere public.
- The endpoint is read-only: there is no code path in `Snapshot.gs` that writes
  to a source sheet.
- Token comparison is constant-time, so a wrong guess leaks nothing through
  response timing.
- The payload contains client usernames and order values. Treat the URL as
  confidential.
