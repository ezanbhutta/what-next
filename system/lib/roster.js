// lib/roster.js, who is on the desk right now.
//
// Source: XStudioz Shift Roster & Coverage Model v1.2, HaseebMadeIt
// Operations, Multan. Five people cover 168 hours a week. The document is the
// authority; this file is a transcription of it and nothing here computes a
// schedule of its own.
//
// WHY THIS EXISTS
//
// Four CSRs open the hub mid-shift and the page could not tell them which of
// the day's work was theirs. It also could not tell anyone that the desk was
// about to change hands, which is the moment work gets dropped: seven
// handovers a day across five people, and the roster's own standing rule 6
// says anything not written down is lost.
//
// TIMEZONE
//
// Every time in the roster is PKT (UTC+5), and PKT has no daylight saving, so
// a fixed offset is correct here and will stay correct. The container runs
// UTC. Deriving the PKT wall clock by arithmetic rather than by trusting
// `process.env.TZ` means a server that moves regions does not silently start
// showing the wrong person on duty.
//
// SHIFTS THAT CROSS MIDNIGHT
//
// Nadir works 9 PM to 9 AM. That is one shift, started on the day named, and
// it means "is Nadir on duty at 3 AM Tuesday" has to look at MONDAY's row.
// Every night shift here is stored on its start day with an end hour lower
// than its start hour, and `onDutyAt` checks the previous day as well as the
// current one. Getting this wrong shows an empty desk during the eight hours
// that are 3 PM to midnight in US Eastern, the heaviest ordering window.

/** Minutes east of UTC. PKT is UTC+5 year round, no daylight saving. */
export const PKT_OFFSET_MINUTES = 5 * 60;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The roster, transcribed from v1.2 section 02.
 *
 * `start` and `end` are hours in PKT. `end <= start` means the shift runs
 * past midnight into the following morning.
 */
export const ROSTER = Object.freeze([
  {
    name: 'Amrah',
    band: 'day',
    hours: 51,
    shifts: { Mon: [9, 17], Tue: [9, 17], Wed: [9, 17], Thu: [9, 17], Fri: [7, 18], Sat: [9, 17] },
    off: ['Sun'],
    note: 'Friday is her long day, 7 AM to 6 PM. Never before 7 AM, never on Sunday.',
  },
  {
    name: 'Zaheen',
    band: 'day',
    hours: 54,
    shifts: { Mon: [9, 18], Tue: [9, 18], Wed: [9, 18], Thu: [9, 18], Fri: [9, 18], Sat: [9, 18] },
    off: ['Sun'],
    note: 'Opens with Amrah and stays an hour past her, holding the evening handover at three people.',
  },
  {
    name: 'Hasnain',
    band: 'evening',
    hours: 52,
    shifts: { Mon: [17, 1], Tue: [17, 1], Wed: [17, 1], Thu: [17, 1], Fri: [21, 9], Sat: [17, 1] },
    off: ['Sun'],
    note: 'Friday is a 12 hour night, not an evening. It is the one shift that gives Nadir a rest day.',
  },
  {
    name: 'Nadir',
    band: 'night',
    hours: 72,
    shifts: { Sat: [21, 9], Sun: [21, 9], Mon: [21, 9], Tue: [21, 9], Wed: [21, 9], Thu: [21, 9] },
    off: ['Fri'],
    note: 'Rest window is Friday 9 AM to Saturday 9 PM, 36 hours. Protected; it is not borrowed.',
  },
  {
    name: 'Ezan',
    band: 'owner',
    hours: 84,
    shifts: { Mon: [11, 23], Tue: [11, 23], Wed: [11, 23], Thu: [11, 23], Fri: [11, 23], Sat: [9, 21], Sun: [9, 21] },
    off: [],
    note: 'Never before 9 AM, never past 11 PM, never a night shift.',
  },
]);

/**
 * The desk handovers, section 05. Every one of these needs a written note.
 *
 * `hour` is PKT. These are the moments work gets dropped, so the page names
 * the next one rather than leaving people to remember seven times a day.
 */
export const HANDOVERS = Object.freeze([
  { hour: 7, what: 'Amrah joins the night CSR', days: ['Fri'] },
  { hour: 9, what: 'the night ends, Amrah and Zaheen open the day' },
  { hour: 11, what: 'Ezan joins', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  { hour: 9, what: 'Ezan joins', days: ['Sat', 'Sun'] },
  { hour: 17, what: 'Amrah leaves, Hasnain joins' },
  { hour: 18, what: 'Zaheen leaves, Ezan and Hasnain hold' },
  { hour: 21, what: 'Nadir joins for the night' },
  { hour: 23, what: 'Ezan leaves, Hasnain and Nadir hold' },
  { hour: 1, what: 'Hasnain leaves, Nadir alone until 9 AM' },
]);

/** The PKT wall clock for an instant, derived rather than trusted from TZ. */
export function pktNow(now = new Date()) {
  const shifted = new Date(now.getTime() + PKT_OFFSET_MINUTES * 60_000);
  return {
    day: DAYS[shifted.getUTCDay()],
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    label: `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')} PKT`,
  };
}

function previousDay(day) {
  return DAYS[(DAYS.indexOf(day) + 6) % 7];
}

/** Does a shift starting at `start` and ending at `end` cover `hour`? */
function covers([start, end], hour, { fromPreviousDay = false } = {}) {
  const overnight = end <= start;
  if (fromPreviousDay) {
    // Only the tail of an overnight shift reaches into today.
    return overnight && hour < end;
  }
  return overnight ? hour >= start : hour >= start && hour < end;
}

/**
 * Who is on the desk at a given PKT day and hour.
 *
 * Checks yesterday's night shifts as well as today's, because a 9 PM to 9 AM
 * shift is stored on the day it STARTS. Without that, every hour between
 * midnight and 9 AM reports an empty desk while Nadir is sitting at it.
 */
export function onDutyAt(day, hour) {
  const yesterday = previousDay(day);
  const on = [];
  for (const person of ROSTER) {
    const today = person.shifts[day];
    const last = person.shifts[yesterday];
    if (today && covers(today, hour)) {
      on.push({ ...person, shift: today, since: today[0], until: today[1] });
    } else if (last && covers(last, hour, { fromPreviousDay: true })) {
      on.push({ ...person, shift: last, since: last[0], until: last[1], overnight: true });
    }
  }
  return on;
}

/** The next handover after `hour` on `day`, and how far away it is. */
export function nextHandover(day, hour, minute = 0) {
  const applies = (h) => !h.days || h.days.includes(day);
  const candidates = HANDOVERS.filter(applies);

  let best = null;
  for (const h of candidates) {
    // Hours ahead of now, wrapping past midnight so 1 AM is "in 2 hours" at
    // 11 PM rather than "23 hours ago".
    let ahead = h.hour - hour;
    if (ahead < 0) ahead += 24;
    if (ahead === 0) continue; // happening now, not next
    const minutesAway = ahead * 60 - minute;
    if (!best || minutesAway < best.minutesAway) best = { ...h, minutesAway };
  }
  return best;
}

/** Formats an hour as a plain 12-hour clock: 9 -> "9 AM", 17 -> "5 PM". */
export function clock(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/**
 * Everything a page needs to say who holds the desk.
 *
 * `depth` is the count, and it matters on its own: the roster's own risk
 * section says midnight to 9 AM runs one person deep every day with no
 * substitute, and Sunday runs one deep for 23 of its 24 hours. A page that
 * shows a lone name without saying it is a lone name hides a known risk.
 */
export function deskNow(now = new Date()) {
  const at = pktNow(now);
  const on = onDutyAt(at.day, at.hour);
  const next = nextHandover(at.day, at.hour, at.minute);
  return {
    ...at,
    on,
    names: on.map((p) => p.name),
    depth: on.length,
    alone: on.length === 1,
    uncovered: on.length === 0,
    next,
  };
}

export default { ROSTER, HANDOVERS, PKT_OFFSET_MINUTES, pktNow, onDutyAt, nextHandover, clock, deskNow, shiftBand };

/**
 * Which shift band an hour falls in, using the hub's own three names.
 *
 * The roster is people-shaped (Amrah 9-5, Hasnain 5pm-1am, Nadir 9pm-9am) and
 * those overlap, so "who is on" cannot be turned into one band without a
 * choice. The choice made here is the handover that OPENS each band, which is
 * how the desk actually talks about it:
 *
 *   Morning  09:00, the day opens
 *   Evening  17:00, Hasnain joins
 *   Night    21:00, Nadir joins
 *
 * It matches shift_report.shift so an activity row and a shift report can be
 * compared. Storing the clock instead, which is what this replaced, put
 * "22:38 PKT" in a column named `shift` and made that comparison impossible.
 */
export function shiftBand(hour) {
  // Number(null) is 0, which is finite, so a bare Number.isFinite check let
  // null through and reported it as Night. An hour nobody supplied is not
  // midnight.
  if (typeof hour !== 'number' && typeof hour !== 'string') return null;
  if (hour === '') return null;
  const h = Number(hour);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  if (h >= 9 && h < 17) return 'Morning';
  if (h >= 17 && h < 21) return 'Evening';
  return 'Night';
}
