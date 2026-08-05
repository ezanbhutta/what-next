-- XStudioz management hub — MySQL schema
--
-- SCOPE RULE: this database holds ONLY what a human types into the hub.
-- Everything computed — orders, inquiries, revenue, health, recovery — is
-- produced by the Python growth engine, committed as JSON into data/, and
-- read from disk. Nothing here duplicates a number the engine already owns.
--
-- The reason is the finding that started this build: the inquiry sheet and
-- the order book disagreed about 25 buyers worth $3,628, and neither knew.
-- A second copy of a number is a second thing that can be wrong. So there is
-- exactly one copy of every computed figure, and this schema is not it.
--
-- The retired volume programme is never named. Its columns are `directed_*`.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------- people

CREATE TABLE IF NOT EXISTS app_user (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(80)  NOT NULL UNIQUE,
  role        ENUM('owner','manager','csr') NOT NULL DEFAULT 'csr',
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Everything that writes leaves a trace. Without this, "who marked this
-- inquiry Not Placed" has no answer, and that question is exactly what the
-- reconciliation finding turned out to hinge on.
CREATE TABLE IF NOT EXISTS audit (
  id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  who     VARCHAR(80) NULL,
  action  VARCHAR(80) NOT NULL,
  detail  JSON        NULL,
  INDEX idx_audit_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- today

CREATE TABLE IF NOT EXISTS task_state (
  run_date  DATE         NOT NULL,
  task_id   VARCHAR(120) NOT NULL,
  done      TINYINT(1)   NOT NULL DEFAULT 0,
  done_by   VARCHAR(80)  NULL,
  done_at   TIMESTAMP    NULL,
  PRIMARY KEY (run_date, task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------- daily entry

-- One row per profile per day. Every metric is NULLABLE on purpose: a blank
-- is "not recorded", which is a different fact from 0, and the difference
-- decides whether a rate has a denominator at all.
CREATE TABLE IF NOT EXISTS daily_entry (
  entry_date       DATE         NOT NULL,
  profile          VARCHAR(80)  NOT NULL,
  impressions      INT          NULL,
  clicks           INT          NULL,
  organic_orders   INT          NULL,
  organic_value    DECIMAL(10,2) NULL,
  directed_orders  INT          NULL,
  directed_value   DECIMAL(10,2) NULL,
  orders_completed INT          NULL,
  completed_value  DECIMAL(10,2) NULL,
  orders_in_queue  INT          NULL,
  total_reviews    INT          NULL,
  -- How many inquiries arrived that day. This was `msg_ratio DECIMAL(5,2)`
  -- and labelled "Message response ratio, percent as Fiverr states it",
  -- which is a different measurement entirely. A count stored as a percent
  -- is not a formatting problem: 4 inquiries would have been read as 4%.
  inquiries_received INT        NULL,
  success_score    INT          NULL,
  profile_rating   DECIMAL(3,2) NULL,
  cancellations    INT          NULL,
  cancelled_value  DECIMAL(10,2) NULL,
  entered_by       VARCHAR(80)  NULL,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (entry_date, profile)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_entry_gig (
  entry_date  DATE         NOT NULL,
  profile     VARCHAR(80)  NOT NULL,
  gig         VARCHAR(160) NOT NULL,
  impressions INT          NULL,
  clicks      INT          NULL,
  PRIMARY KEY (entry_date, profile, gig)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------- reconciliation

-- The referee. The hub never edits the inquiry sheet or the order book; it
-- reports where they disagree and tracks what was done about each case.
CREATE TABLE IF NOT EXISTS reconciliation (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  buyer        VARCHAR(120) NOT NULL,   -- fiverr username: the only real key
  finding      ENUM('marked_lost_but_ordered',
                    'marked_won_no_order',
                    'order_without_inquiry') NOT NULL,
  first_seen   DATE          NOT NULL,
  amount       DECIMAL(10,2) NULL,
  resolved     TINYINT(1)    NOT NULL DEFAULT 0,
  resolved_by  VARCHAR(80)   NULL,
  resolved_at  TIMESTAMP     NULL,
  resolution   TEXT          NULL,
  UNIQUE KEY uq_recon (buyer, finding)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------ team review

-- self_score is asked BEFORE manager_score, per the team-review sheet's own
-- step 1. Storing both lets the gap be the coaching signal rather than the
-- score itself.
CREATE TABLE IF NOT EXISTS team_week (
  week_ending        DATE        NOT NULL,
  person             VARCHAR(80) NOT NULL,
  self_score         TINYINT     NULL,
  manager_score      TINYINT     NULL,
  note               TEXT        NULL,
  promise            TEXT        NULL,
  prev_promise_done  ENUM('yes','half','no') NULL,
  recorded_by        VARCHAR(80) NULL,
  updated_at         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (week_ending, person),
  CONSTRAINT chk_self    CHECK (self_score    IS NULL OR self_score    BETWEEN 1 AND 5),
  CONSTRAINT chk_manager CHECK (manager_score IS NULL OR manager_score BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS decision (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  decided_on  DATE        NOT NULL,
  what        TEXT        NOT NULL,
  expected    TEXT        NULL,
  actual      TEXT        NULL,
  was_right   ENUM('yes','no','partly','pending') NOT NULL DEFAULT 'pending',
  author      VARCHAR(80) NULL,
  INDEX idx_decision_on (decided_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------- responses + msgs

CREATE TABLE IF NOT EXISTS response (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(120) NOT NULL,
  body         MEDIUMTEXT   NOT NULL,
  when_to_use  TEXT         NULL,
  category     VARCHAR(60)  NULL,
  source       ENUM('fiverr','extra','hub') NOT NULL DEFAULT 'hub',
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  uses         INT          NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_response_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS client_note (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  buyer        VARCHAR(120) NOT NULL,
  at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  author       VARCHAR(80)  NULL,
  kind         ENUM('note','sent','flag') NOT NULL DEFAULT 'note',
  body         TEXT         NOT NULL,
  response_id  INT          NULL,
  INDEX idx_note_buyer (buyer, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------ client talk hub

-- The owner's own playbook: what a buyer says, and the line that goes back.
--
-- It is a TABLE rather than a constant in views/messages.js because the person
-- who writes these lines is Ezan, not whoever is deploying. A sentence that
-- costs an order should be fixable at 11pm from a phone, and a sentence that
-- wins one should be addable the day it works. db/seed-talk.js loads the
-- starting set out of db/client-talk-hub.html; everything after that is typed
-- here.
--
-- `slug` IS THE SEED'S IDENTITY, AND IT IS NULLABLE ON PURPOSE.
-- Re-running the seed must not duplicate a row, so each seeded card carries a
-- stable slug and the seed is INSERT IGNORE against this unique key. Cards the
-- owner adds in the hub have slug NULL, and a MySQL UNIQUE index ignores NULLs
-- entirely — so any number of hub-written cards coexist while a second seed run
-- inserts nothing. Keying idempotency on the title instead would have broken
-- the moment the owner reworded one: the seed would have seen a new card and
-- inserted the old text back underneath the edit.
--
-- `stage` and `turns` are JSON because both are genuinely lists. A card is
-- offered at one or more stages of an order (inquiry, kickoff, working,
-- approved, delivered, or `all`), and a card holds one or more exchanges. The
-- alternative was a comma-joined string, which is a parser waiting to be wrong
-- about the first stage name containing a comma.
--
--   stage  ["inquiry","kickoff"]
--   turns  [{"h":"what the buyer says","s":"what goes back",
--            "u":"which package it opens","w":"the warning on this line"}]
--
-- `kind` is the treatment, and it is NOT the same as `group`. One card in
-- "When they say no" is a buying signal rather than an objection, and it has to
-- read as go rather than stop. Deriving the treatment from the group would have
-- painted it red.
--
-- Nothing here is a number, so nothing here duplicates an engine figure. This
-- table is words.
CREATE TABLE IF NOT EXISTS talk (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(80)  NULL,
  heading     VARCHAR(80)  NOT NULL,   -- the section it renders under
  `group`     VARCHAR(24)  NOT NULL,   -- ask | up | obj | care
  kind        ENUM('ask','stop','care') NOT NULL DEFAULT 'ask',
  stage       JSON         NOT NULL,
  chips       JSON         NULL,
  title       VARCHAR(200) NOT NULL,
  sub         TEXT         NULL,
  turns       JSON         NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  sort        SMALLINT     NOT NULL DEFAULT 0,
  source      ENUM('playbook','hub') NOT NULL DEFAULT 'hub',
  author      VARCHAR(80)  NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_talk_slug (slug),
  INDEX idx_talk_order (active, `group`, sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- upsell

-- Mirrors the XStudioz Sheet's RESEARCH -> OPPORTUNITY -> SELLING flow, but
-- keyed on the fiverr username so a row can be checked against the order
-- book instead of being a name someone typed twice.
CREATE TABLE IF NOT EXISTS upsell (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  buyer         VARCHAR(120) NOT NULL,
  business      VARCHAR(160) NULL,
  gap           VARCHAR(120) NULL,
  sell_first    VARCHAR(120) NULL,
  stage         ENUM('research','pitch','followup','won','lost')
                NOT NULL DEFAULT 'research',
  asked         TINYINT(1)    NOT NULL DEFAULT 0,
  result        VARCHAR(160)  NULL,
  extra_earned  DECIMAL(10,2) NULL,
  owner         VARCHAR(80)   NULL,
  next_step     TEXT          NULL,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_upsell (buyer, gap),
  INDEX idx_upsell_stage (stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------- section access

-- Which sections are restricted, and to whom. Ezan sets this from inside the
-- hub; it is deliberately DATA rather than code so locking a section never
-- needs a deploy, and so the lock list is auditable.
--
-- `min_role` is the lowest role that may open the section. Roles ascend
-- csr < manager < owner, so min_role='owner' means Ezan only.
--
-- A section absent from this table is open to everyone who can log in. That
-- default is deliberate: a section should be visibly locked, not invisibly
-- missing. A CSR who cannot open Money should be told it is restricted —
-- silently hiding it makes people think the hub is broken.
CREATE TABLE IF NOT EXISTS section_access (
  section    VARCHAR(40) NOT NULL PRIMARY KEY,
  min_role   ENUM('csr','manager','owner') NOT NULL DEFAULT 'csr',
  locked_by  VARCHAR(80) NULL,
  locked_at  TIMESTAMP   NULL,
  reason     VARCHAR(200) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================== REPORTS (10)
--
-- The shift logger, brought inside the hub. Three tables: the shift a person
-- opened, what they logged during it, and the follow-throughs that logging
-- booked. `lib/reminders.js` owns all thirteen booking rules; this file owns
-- only where the rows live.
--
-- WHY IT MOVED. The original ran on Supabase with anon RLS of `using (true)`
-- on every table, and the publishable key shipped inside the browser bundle.
-- Anyone who opened devtools could DELETE every report the team had ever
-- filed. Here the writes are server-side through auditedWrite() and the
-- credentials never reach a browser — the same removal-of-the-class-of-problem
-- that made the whole hub server-rendered.
--
-- SCOPE. These tables ARE the source of truth for shift activity: nobody else
-- computes it, so this is not a second copy of an engine number. Money,
-- conversion and order state still come from data/ and are never recomputed
-- from here.
--
-- TIME. due_at and snoozed_until are DATETIME holding UTC. They are DATETIME
-- rather than TIMESTAMP because a custom reminder may legitimately be set past
-- 2038, and TIMESTAMP silently cannot hold that. Write them with
-- reminders.toSqlUtc() and read them back with reminders.parseAt() — a
-- 'YYYY-MM-DD HH:MM:SS' string handed to `new Date()` is parsed as LOCAL time,
-- which on a PKT box would move every reminder five hours.

-- THE WRAP-UP IS PART OF THE SHIFT, NOT A SECOND RECORD. `handoff_note`,
-- `note_shifts` and `checklist` live on the shift they describe because all
-- three are answers to "how did this shift go" and splitting them into their
-- own table would let a shift exist with a note that points at no shift.
--
-- `note_shifts` is the JSON array of shift names the note was aimed at, and
-- `checklist` the JSON map of wrap-up items ticked (plus their optional
-- counts). Both are JSON rather than columns because the checklist is a list
-- the owner changes — views/reports.js CHECKLIST is the authority — and a
-- schema migration is the wrong price for adding a line to it. Nothing joins
-- on either, so nothing needs them indexed.
--
-- A BLANK COUNT IS NOT ZERO. `{"briefs_created": true}` means ticked but not
-- counted; `{"briefs_created": 4}` means four. The CEO view prints the first
-- as MISSING and never as 0 — see house rule 2.
CREATE TABLE IF NOT EXISTS shift_report (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  person       VARCHAR(80) NOT NULL,
  profile      VARCHAR(80) NOT NULL,
  shift        ENUM('Morning','Evening','Night') NOT NULL,
  opened_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at    TIMESTAMP   NULL,
  status       ENUM('open','closed') NOT NULL DEFAULT 'open',
  notes        TEXT        NULL,
  handoff_note TEXT        NULL,
  note_shifts  JSON        NULL,
  checklist    JSON        NULL,

  -- One OPEN report per person per profile. MySQL has no partial index, so the
  -- slot is NULL for closed rows and a unique index ignores NULLs — closed
  -- history stays unbounded while a second open report cannot be created.
  open_slot  VARCHAR(170) GENERATED ALWAYS AS
             (IF(status = 'open', CONCAT(person, '|', profile), NULL)) STORED,
  UNIQUE KEY uq_shift_open (open_slot),
  INDEX idx_shift_profile (profile, status, opened_at),
  INDEX idx_shift_opened (opened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who has read a handoff note.
--
-- A note aimed at two shifts has to be read by BOTH, and "read" is per shift,
-- not per note: marking it read on Evening must not make it disappear from
-- Night's page before anyone on Night has seen it. So the key is
-- (report_id, shift) and the Evening row says nothing about the Night one.
--
-- It is a table rather than a `read_at` column on shift_report for exactly
-- that reason — one column can only record one reader, and the first one to
-- tap it would silently close the note for everybody else.
CREATE TABLE IF NOT EXISTS shift_handoff_read (
  report_id  BIGINT      NOT NULL,
  shift      ENUM('Morning','Evening','Night') NOT NULL,
  read_by    VARCHAR(80) NULL,
  read_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id, shift),
  CONSTRAINT fk_handoff_report FOREIGN KEY (report_id)
    REFERENCES shift_report(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- What a CSR logged during a shift. `kind` is the activity catalogue; the same
-- list is ACTIVITY_KIND_KEYS in lib/reminders.js and a test fails if the two
-- drift. It is an ENUM rather than a VARCHAR because a misspelt kind books no
-- reminder at all, and that failure is invisible — the entry saves, the shift
-- looks logged, and the follow-through simply never appears.
--
-- `client` is the buyer (Fiverr username where there is one) and `client_key`
-- is its join form — lowercased, non-alphanumerics stripped, exactly as
-- lib/reconcile.js normalises a buyer. Write it with reminders.buyerKey(); it
-- is a stored column rather than a generated one so that one function defines
-- the normalisation for both the SQL and the engine.
--
-- `order_ref` is the project/order this entry is about. The original overloaded
-- one field for both — "Order Assigned to Designer" put the project name in the
-- column called `client` — which is why its reminders could only ever be
-- matched by project. Here they are two columns.
CREATE TABLE IF NOT EXISTS activity (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  report_id   BIGINT NOT NULL,
  kind        ENUM('inquiry','lead_followup','client_conversation',
                   'new_order','order_assigned','files_assigned','order_completed',
                   'revision_assigned',
                   'project_delivered','shared',
                   'followup_client','followup_designer','update_followup',
                   'upsell','offer','custom_reminder',
                   'review_request','review_received',
                   'meeting',
                   'frustrated','disputed','extension','spam') NOT NULL,
  client      VARCHAR(120) NULL,
  client_key  VARCHAR(120) NULL,
  order_ref   VARCHAR(160) NULL,
  detail      JSON         NULL,
  at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  author      VARCHAR(80)  NULL,
  CONSTRAINT fk_activity_report FOREIGN KEY (report_id)
    REFERENCES shift_report(id) ON DELETE CASCADE,
  INDEX idx_activity_report (report_id, at),
  INDEX idx_activity_kind (kind, at),
  INDEX idx_activity_client (client_key, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A booked follow-through.
--
-- PROFILE-SCOPED, NOT PERSON-SCOPED. The spec is explicit: a reminder belongs
-- to the profile and pops for whoever is covering it at the time, any shift,
-- any CSR. So the queue index leads with `profile` and never mentions the
-- person who booked it; `report_id` records which shift booked it, and is
-- evidence, not routing.
--
-- `rule` is the numbered logic in REMINDER-LOGICS.md (1-13). `rule_key` is the
-- exact stage within it, because rule 9 is a three-step chain and rule 10 is
-- reachable from two different activities. `chain_step` is 1 unless the rule
-- chains.
--
-- There is deliberately NO unique key on (activity_id, rule_key). "One
-- reminder per entry per rule" is enforced in reminders.alreadyBooked(),
-- because it has one exception a constraint cannot express: a reminder that
-- was AUTO-CLEARED may be booked again if editing the entry makes the rule
-- true once more, while one a human resolved must never come back.
CREATE TABLE IF NOT EXISTS reminder (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  report_id     BIGINT       NULL,
  activity_id   BIGINT       NULL,
  `rule`        TINYINT      NOT NULL,
  rule_key      VARCHAR(40)  NOT NULL,
  chain_step    TINYINT      NOT NULL DEFAULT 1,
  profile       VARCHAR(80)  NOT NULL,
  client        VARCHAR(120) NULL,
  client_key    VARCHAR(120) NULL,
  order_ref     VARCHAR(160) NULL,
  due_at        DATETIME     NOT NULL,
  heading       VARCHAR(200) NOT NULL,
  body          TEXT         NULL,
  alert         TINYINT(1)   NOT NULL DEFAULT 0,
  state         ENUM('pending','snoozed','resolved') NOT NULL DEFAULT 'pending',
  resolution    VARCHAR(40)  NULL,
  snoozed_until DATETIME     NULL,
  resolved_by   VARCHAR(80)  NULL,
  resolved_at   TIMESTAMP    NULL,
  booked_by     VARCHAR(80)  NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_reminder_rule CHECK (`rule` BETWEEN 1 AND 13),
  CONSTRAINT fk_reminder_activity FOREIGN KEY (activity_id)
    REFERENCES activity(id) ON DELETE CASCADE,
  CONSTRAINT fk_reminder_report FOREIGN KEY (report_id)
    REFERENCES shift_report(id) ON DELETE SET NULL,
  -- The query the CSR page runs on every load: what is due for THIS profile.
  INDEX idx_reminder_queue (profile, state, due_at),
  -- Auto-clear: "an upsell for this buyer was logged — drop the nudge."
  INDEX idx_reminder_clear (profile, client_key, rule_key, state),
  -- "Has this entry already booked this rule?" and the FK cascade.
  INDEX idx_reminder_entry (activity_id, rule_key),
  INDEX idx_reminder_ledger (state, resolved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------ promised delivery

-- The date we told the buyer the work would land.
--
-- WHY THIS TABLE EXISTS
--
-- The order sheet has an order date and a delivered date and nothing in
-- between. So "past 60 days" is AGE SINCE ORDERING, which is not the same
-- thing as LATE. An order with an agreed 90-day scope is not late on day 61,
-- and an order promised in 5 days is late on day 6 while sitting nowhere near
-- the 60-day band. Every triage decision, the dispute-risk read and the
-- review gate all rested on a distinction the data did not encode.
--
-- The sheet stays read-only, so the date lives here: this is the hub's rule,
-- one row per order, typed by a person, never derived and never guessed.
--
-- THE KEY, AND WHY IT IS NOT AN ID
--
-- The sheet has no order number. `order_key` is derived from the three fields
-- that identify a row in it: buyer, project and order date, each lowercased
-- with non-alphanumerics stripped. Measured against all 1,073 orders, that is
-- unique with zero collisions.
--
-- It is also fragile in one specific way, and the columns beside it are the
-- answer to that: if somebody renames a project in the sheet, the key changes
-- and this row stops matching. `buyer`, `project` and `order_date` are stored
-- again in plain form so an orphaned promise can be shown to a person and
-- re-attached, rather than vanishing and taking the only record of what was
-- promised with it. Nothing here is recomputed from the sheet; these three
-- are a copy kept deliberately, for identification, not for arithmetic.
--
-- `due_date` is the ONLY number this table contributes, and no engine figure
-- duplicates it. What the engine computes is age; what this holds is a
-- promise. A page may compare them. Neither replaces the other.
CREATE TABLE IF NOT EXISTS order_due (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_key   VARCHAR(200) NOT NULL,
  buyer       VARCHAR(120) NOT NULL,
  project     VARCHAR(200) NULL,
  order_date  DATE         NULL,
  due_date    DATE         NOT NULL,
  note        TEXT         NULL,        -- why this date, in the typist's words
  set_by      VARCHAR(80)  NULL,
  set_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
  -- One promise per order. Changing it is an UPDATE, and set_at records when.
  UNIQUE KEY uq_order_due (order_key),
  INDEX idx_order_due_buyer (buyer)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
