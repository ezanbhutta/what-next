# Access status

What the engine can and cannot reach, as of 2026-07-29.

## Reachable

| Source | Method | Notes |
|---|---|---|
| Order / CRM workbook | Google Drive connector | 803 order rows, 326 ledger days, 334 script errors |
| Inquiry workbook | Google Drive connector | 1,000 leads across 10 tab layouts |
| Live gig page | public fetch | level, review histogram, queue depth, response time |
| CSR handoff tracker | manual `.xlsx` upload | 8 active orders |

## Not reachable

### CSR Pulse — `https://csr-pulse-vbsz.vercel.app/`

Password-gated. The page renders only a sign-in form:

```
CSR Pulse · HaseebMadeIt
Access password / Sign in
Internal · Confidential · For authorized staff only
```

**To wire it up, pick one:**

1. **Best — add a read-only JSON endpoint.** Something like `/api/export?token=…`
   returning the same data the dashboard shows. The engine fetches it daily and never
   needs a session. This is the option that survives password rotation.
2. **Export on a schedule** to a Google Sheet the engine already reads.
3. Share the access password. Workable, but it lands credentials in a config file and
   breaks whenever the password changes. Prefer 1 or 2.

### CSR Shift Logger / Reports — `https://reports-six-coral.vercel.app/#ceo`

Device-gated. The page reports:

```
This device isn't registered
Ask your manager to assign this laptop a profile in the CEO console.
Device code: C6AC-6F
```

The engine runs in an ephemeral container, so **registering this device will not help** —
the container is destroyed between sessions and the next run gets a different device code.
Device registration is the wrong mechanism for a machine consumer.

**To wire it up:** add a token-authenticated export endpoint, or schedule an export into
a Google Sheet. Same reasoning as above.

## Promised but not yet existing

Tracked in `config/sources.yml` under `expected_but_missing`. The engine emits a task
about these every day until they exist, so the gap stays visible rather than being
quietly forgotten.

- **Disputes / dead / conflicted orders sheet** — dispute-risk scoring and refund exposure.
- **Impression system** — the analytically most valuable of the three. Without impressions
  the engine cannot separate *falling reach* from *falling conversion*, and those two need
  opposite responses. Right now, when organic drops, the engine can say it dropped but not
  reliably why.
- **Daily team activity report** — attribute outcome changes to team actions rather than
  to Fiverr's algorithm.

## How to add a source

See "Adding a new data source" in `CLAUDE.md`. Short version: add it to
`config/sources.yml`, add its header spellings to the alias table in `xstudioz/ingest.py`,
add a drift test, run the suite.
