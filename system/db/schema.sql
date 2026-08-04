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
  msg_ratio        DECIMAL(5,2) NULL,
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
