/**
 * XStudioz snapshot service.
 *
 * Runs inside the user's own Google account and does two things:
 *
 *   1. `doGet` serves a clean JSON snapshot of every source workbook over
 *      plain HTTPS, guarded by a shared token. Any runner — a Claude
 *      Routine, a GitHub Action, a laptop — can fetch it without needing a
 *      Google connector grant. That independence is the point.
 *
 *   2. `writeDailySnapshot` runs on a time-driven trigger and drops the same
 *      JSON into a Drive folder. This is the "belt" to `doGet`'s "braces":
 *      it keeps producing snapshots even on mornings when nothing calls the
 *      endpoint, so there is always a recent file to fall back to.
 *
 * READ-ONLY on every source workbook. This script opens spreadsheets with
 * openById and only ever calls getDataRange().getValues(). It writes nothing
 * back — the team depends on those sheets live.
 *
 * It deliberately does NOT map columns to canonical field names. Header
 * aliasing lives in xstudioz/ingest.py so there is exactly one implementation
 * to keep correct. This script's job is transport: real tab names, real
 * headers, real rows, small payload, no markdown.
 *
 * ---------------------------------------------------------------------------
 * SETUP — see automation/README.md for the walkthrough.
 * ---------------------------------------------------------------------------
 */

var SCHEMA_VERSION = 1;

/** Source workbooks. Add new ones here; the engine picks them up by role. */
var SOURCES = [
  { id: 'orders',      fileId: '1kHw1DB7r4RhgBpF4l4CtapBdgtozJwJXtF-egVBZGUE' },
  { id: 'inquiries',   fileId: '1Pp6RhsR96FzGfB3MV--CYj7Idja2-iyF7BNPhJ9Md_A' },
  // Added by createMissingSourceSheets(); paste the ids it logs.
  { id: 'impressions', fileId: '1FKLA1af8Q8rhXTl-QnGLoFQ43asymHIQk59g8Su0ekA' },
  { id: 'disputes',    fileId: '' }
];

/**
 * Tab classification by header fingerprint, not by tab name or position.
 * Names drift ("Nov 2025" -> "November"), positions get reordered, but a tab
 * that has both "Organic Orders" and "VVRO Orders" is the daily ledger no
 * matter what it is called.
 *
 * Order matters: the first rule whose `all` headers are present wins, so the
 * most specific fingerprints are listed first.
 */
var ROLE_RULES = [
  // Impressions FIRST. The impressions sheet also carries organic and VVRO
  // order columns, so a daily_flow rule placed above this would claim it and
  // double-count every order against the real ledger.
  { role: 'impressions',       all: ['impressions'] },
  { role: 'daily_flow',        all: ['organic orders', 'vvro orders'] },
  { role: 'automation_health', all: ['timestamp', 'message'] },
  { role: 'disputes',          all: ['dispute type'] },
  { role: 'active_orders',     all: ['current status', 'csr handoff notes'] },
  { role: 'funnel',            all: ['client name', 'order status'] },
  { role: 'crm_orders',        all: ['client name', 'project name'] },
  { role: 'crm_orders',        all: ['client name', 'order amount'] },
  { role: 'funnel',            all: ['client name', 'country'] },
  { role: 'crm_orders',        all: ['client name'] }
];

var MAX_ROWS_PER_TAB = 5000;   // guardrail against a runaway sheet
var MAX_COLS = 60;

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet(e) {
  try {
    var expected = PropertiesService.getScriptProperties()
      .getProperty('SNAPSHOT_TOKEN');
    if (!expected) {
      return json_({ schema_version: SCHEMA_VERSION,
        error: 'SNAPSHOT_TOKEN is not set in Script Properties. See automation/README.md.' });
    }
    var given = (e && e.parameter && e.parameter.token) || '';
    if (!constantTimeEquals_(given, expected)) {
      return json_({ schema_version: SCHEMA_VERSION, error: 'unauthorized' });
    }
    return json_(buildSnapshot_('apps_script'));
  } catch (err) {
    // Always return valid JSON. An HTML error page would fail the engine's
    // parser with a message that says nothing useful.
    return json_({ schema_version: SCHEMA_VERSION,
                   error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------------------
// Time-driven backup
// ---------------------------------------------------------------------------

/** Install with installDailyTrigger(). Writes the snapshot into Drive. */
function writeDailySnapshot() {
  var snap = buildSnapshot_('apps_script');
  var folder = getOrCreateFolder_('XStudioz Engine Snapshots');
  var name = 'snapshot-' + Utilities.formatDate(
    new Date(), 'Etc/UTC', 'yyyy-MM-dd') + '.json';

  // One file per day, overwritten on re-run, so the folder does not grow
  // without bound.
  var existing = folder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);

  folder.createFile(name, JSON.stringify(snap), MimeType.PLAIN_TEXT);
  pruneOldSnapshots_(folder, 60);
  Logger.log('wrote ' + name + ' (' + snap.tables.length + ' tables)');
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'writeDailySnapshot') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 01:00-02:00 UTC, ahead of the Claude Routine at 02:13 UTC so the file is
  // already on disk if the live fetch fails.
  ScriptApp.newTrigger('writeDailySnapshot')
    .timeBased().everyDays(1).atHour(1).inTimezone('Etc/UTC').create();
  Logger.log('daily trigger installed for 01:00-02:00 UTC');
}

function pruneOldSnapshots_(folder, keepDays) {
  var cutoff = new Date(Date.now() - keepDays * 86400000);
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (f.getDateCreated() < cutoff) f.setTrashed(true);
  }
}

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

function buildSnapshot_(generatedBy) {
  var tables = [];
  var warnings = [];

  SOURCES.forEach(function (src) {
    if (!src.fileId) {
      warnings.push('source "' + src.id + '" has no fileId configured');
      return;
    }
    var ss;
    try {
      ss = SpreadsheetApp.openById(src.fileId);
    } catch (err) {
      warnings.push('cannot open "' + src.id + '": ' + (err && err.message || err));
      return;
    }
    ss.getSheets().forEach(function (sheet) {
      var t = readSheet_(sheet, src.id, warnings);
      if (t) tables.push(t);
    });
  });

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    generated_by: generatedBy,
    warnings: warnings,
    gig: readGigOverrides_(),
    tables: tables
  };
}

function readSheet_(sheet, sourceId, warnings) {
  var name = sheet.getName();
  if (name.charAt(0) === '_') return null;          // convention: _x is private

  var lastRow = Math.min(sheet.getLastRow(), MAX_ROWS_PER_TAB + 1);
  var lastCol = Math.min(sheet.getLastColumn(), MAX_COLS);
  if (lastRow < 2 || lastCol < 1) return null;      // header only, or empty

  if (sheet.getLastRow() > MAX_ROWS_PER_TAB + 1) {
    warnings.push('tab "' + name + '" truncated at ' + MAX_ROWS_PER_TAB + ' rows');
  }

  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var header = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });

  // Drop trailing empty columns so the payload stays small.
  var width = header.length;
  while (width > 0 && !header[width - 1]) width--;
  if (width === 0) return null;
  header = header.slice(0, width);

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i].slice(0, width).map(function (c) {
      return String(c == null ? '' : c).trim();
    });
    if (row.join('')) rows.push(row);               // skip fully blank rows
  }
  if (!rows.length) return null;

  return {
    name: name,
    role: classify_(header),
    source_id: sourceId,
    header: header,
    rows: rows
  };
}

function classify_(header) {
  var lower = header.map(function (h) { return String(h).toLowerCase().trim(); });
  var has = function (needle) {
    return lower.some(function (h) { return h.indexOf(needle) !== -1; });
  };
  for (var i = 0; i < ROLE_RULES.length; i++) {
    var rule = ROLE_RULES[i];
    if (rule.all.every(has)) return rule.role;
  }
  return 'unknown';
}

/**
 * Optional manual gig figures, for days when nobody scrapes the gig page.
 * Create a sheet named `_gig` in the orders workbook with key/value rows.
 * Leading underscore keeps it out of the table export.
 */
function readGigOverrides_() {
  try {
    var ss = SpreadsheetApp.openById(SOURCES[0].fileId);
    var sheet = ss.getSheetByName('_gig');
    if (!sheet) return {};
    var out = {};
    sheet.getDataRange().getValues().forEach(function (row) {
      var k = String(row[0] || '').trim();
      if (!k) return;
      var v = row[1];
      out[k] = (v === '' || v == null) ? null
        : (isNaN(Number(v)) ? String(v) : Number(v));
    });
    return out;
  } catch (err) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Missing-source scaffolding
// ---------------------------------------------------------------------------

/**
 * Creates the two workbooks the engine needs but does not yet have, with the
 * exact headers it already knows how to read. Run once, then paste the logged
 * ids into SOURCES above.
 *
 * The headers are not suggestions — they are the contract. Renaming a column
 * is what schema drift is, and the engine will report it as such.
 */
function createMissingSourceSheets() {
  var made = [];

  var imp = SpreadsheetApp.create('XStudioz — Impressions');
  var impSheet = imp.getSheets()[0].setName('Impressions');
  impSheet.getRange(1, 1, 1, 7).setValues([[
    'Date', 'Profile', 'Gig', 'Impressions', 'Clicks', 'Orders', 'Notes'
  ]]).setFontWeight('bold');
  impSheet.setFrozenRows(1);
  impSheet.getRange('A2').setNote(
    'One row per gig per day. Impressions and Clicks come from Fiverr Analytics.\n' +
    'This is the single most valuable missing input: without it the engine can '  +
    'tell you organic dropped, but not whether reach fell or conversion fell — '  +
    'and those need opposite responses.');
  made.push(['impressions', imp.getId(), imp.getUrl()]);

  var dis = SpreadsheetApp.create('XStudioz — Disputes & Dead Orders');
  var disSheet = dis.getSheets()[0].setName('Disputes');
  disSheet.getRange(1, 1, 1, 10).setValues([[
    'Date', 'Client Name', 'Order Amount', 'Dispute Type', 'Status',
    'Opened On', 'Resolved On', 'Amount Refunded', 'Root Cause', 'Notes'
  ]]).setFontWeight('bold');
  disSheet.setFrozenRows(1);
  disSheet.getRange('D2:D').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(
      ['refund_requested', 'refund_given', 'cancelled', 'dead', 'chargeback',
       'quality_complaint', 'late_delivery'], true).build());
  disSheet.getRange('I2:I').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(
      ['brief_mismatch', 'quality', 'communication', 'late', 'scope_creep',
       'buyer_changed_mind', 'scammer', 'unknown'], true).build());
  made.push(['disputes', dis.getId(), dis.getUrl()]);

  made.forEach(function (m) {
    Logger.log('created %s\n  fileId: %s\n  url: %s', m[0], m[1], m[2]);
  });
  Logger.log('\nPaste those fileIds into SOURCES at the top of this script, '
             + 'then share both sheets with the team.');
  return made;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** Avoids leaking token length or prefix through early-exit timing. */
function constantTimeEquals_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Generates and stores a token. Run once; copy the value it logs. */
function generateToken() {
  var bytes = Utilities.getUuid().replace(/-/g, '')
            + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('SNAPSHOT_TOKEN', bytes);
  Logger.log('SNAPSHOT_TOKEN = %s\n\nStore this as XSTUDIOZ_SNAPSHOT_TOKEN '
             + 'wherever the engine runs. Do not commit it.', bytes);
  return bytes;
}

/** Sanity check before deploying. Logs what the engine will see. */
function testSnapshot() {
  var snap = buildSnapshot_('test');
  Logger.log('generated_at: %s', snap.generated_at);
  Logger.log('warnings: %s', JSON.stringify(snap.warnings));
  snap.tables.forEach(function (t) {
    Logger.log('  [%s] %s — %s rows, %s cols', t.role, t.name,
               t.rows.length, t.header.length);
  });
  var unknown = snap.tables.filter(function (t) { return t.role === 'unknown'; });
  if (unknown.length) {
    Logger.log('\n%s tab(s) could not be classified: %s\nAdd a fingerprint to '
               + 'ROLE_RULES if any of them carry signal.', unknown.length,
               unknown.map(function (t) { return t.name; }).join(', '));
  }
  Logger.log('\npayload: ~%s KB', Math.round(JSON.stringify(snap).length / 1024));
  return snap;
}
