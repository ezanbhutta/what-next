# Snapshot — Supabase project `aeytsgipuuyjlbvebhez` ("reports")

Taken 2026-08-04, read-only, before any remediation.

Row counts verified against `select count(*)` at capture time:

| table | rows |
|---|---|
| actions | 6587 |
| reminders | 942 |
| reports | 579 |
| roster | 44 |
| devices | 13 |
| settings | 1 |
| growth_task_state | 1 |
| security_log | 0 |
| mistakes | 0 |

`actions` needs pagination — a plain `select=*` returns PostgREST's default
first 1000 rows and looks like a complete backup. It is not. Page it.

## Why this exists

Live RLS on this project grants role `public`:

    reports  DELETE  USING (true)
    devices  ALL     USING (true) WITH CHECK (true)
    roster   ALL     USING (true) WITH CHECK (true)
    settings ALL     USING (true) WITH CHECK (true)

The anon key ships in every client bundle by design, so RLS is the only
guard and it is not guarding. Anyone holding that key can delete all 579
reports, cascading 6587 actions.

The owner has instructed that no existing system be changed. The policies
are therefore UNCHANGED and the exposure remains open. This snapshot exists
so that a wipe is recoverable rather than terminal. Re-take it whenever the
data since the last capture matters.

Restore is a plain PostgREST POST of each file back to its table.
