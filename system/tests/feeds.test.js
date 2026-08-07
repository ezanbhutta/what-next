// tests/feeds.test.js, the page whose whole job is to tell you when a number
// cannot be trusted.
//
// It has one failure mode worth more than all the others: reporting healthy
// when something has stopped. A feed page that is wrong in that direction is
// worse than no feed page, because it converts "I should check" into "it said
// it was fine".

import test from 'node:test';
import assert from 'node:assert/strict';

const { render } = await import('../views/feeds.js');

const feed = (over = {}) => ({
  key: 'x', label: 'A feed', source: 'somewhere',
  status: 'live', as_of: '2026-08-07', age_hours: 1, detail: 'fine', fix: '',
  ...over,
});

const ctx = (over = {}) => ({
  data: { runDate: '2026-08-07', engineFeeds: [feed()], storeFeeds: [feed({ label: 'B' })], ...over },
  user: { name: 'Ezan', role: 'owner' }, query: {},
});
const text = (over) => String(render(ctx(over)).html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the page leads with the worst feed, never the healthiest', () => {
  const out = render(ctx({
    engineFeeds: [feed({ label: 'Healthy one' }), feed({ label: 'Dead one', status: 'unreachable', age_hours: null })],
    storeFeeds: [feed({ label: 'Old one', status: 'stale', age_hours: 240 })],
  }));
  assert.match(out.title, /unreachable/i,
    'three feeds, one unreachable, and the title did not say so. A page that leads with the healthy ' +
    'ones is a page on which a broken feed stays broken.');
  const page = String(out.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(page.indexOf('Dead one') < page.indexOf('Healthy one'), 'rows must be worst-first');
});

test('stale and unreachable are never collapsed into one word', () => {
  const page = text({
    engineFeeds: [feed({ status: 'unreachable', age_hours: null, label: 'No key' })],
    storeFeeds: [feed({ status: 'stale', age_hours: 240, label: 'Not filled in' })],
  });
  assert.match(page, /Stale/, 'the stale feed lost its own word');
  assert.match(page, /Unreachable/, 'the unreachable feed lost its own word');
  const out = render(ctx({
    engineFeeds: [feed({ status: 'unreachable', age_hours: null })],
    storeFeeds: [feed({ status: 'stale', age_hours: 240 })],
  }));
  const t = out.ticker.map((x) => x.label);
  assert.ok(t.includes('Stale') && t.includes('Unreachable'),
    'the ticker must count them separately: one is a person who stopped filling something in, the ' +
    'other is a credential or a service, and they send you to different places');
});

test('an all-live system says so plainly and asks for nothing', () => {
  const out = render(ctx());
  assert.match(out.title, /All 2 feeds live/);
  const page = String(out.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(page, /Nothing here needs a person/,
    'with everything live the actions panel must be empty rather than inventing work');
});

test('a half that could not be read is unknown, not healthy', () => {
  // The engine half comes from the last run. If that run cannot be read, the
  // sheet, gig and tracker feeds are absent from the table entirely, and the
  // page must NOT let their absence read as an all-clear.
  const page = text({ engineFeeds: null });
  assert.match(page, /not represented above at all/,
    'a missing half must be called out; otherwise four missing feeds look like four healthy ones');
  const out = render(ctx({ engineFeeds: null }));
  assert.ok(!/All \d+ feeds live/.test(out.title),
    'the title claimed everything was live while half the feeds were unreadable');
});

test('both halves unreadable is its own loud state', () => {
  const out = render(ctx({ engineFeeds: null, storeFeeds: null }));
  assert.match(out.title, /could not run/i);
  assert.deepEqual(out.ticker, [], 'no count may be stated when nothing could be checked');
});

test('every feed that is not live carries something to do about it', () => {
  const page = text({
    engineFeeds: [feed({ status: 'stale', age_hours: 300, label: 'Board', detail: 'stopped 10 days ago',
                         fix: 'Somebody has to fill it in.' })],
    storeFeeds: [],
  });
  assert.match(page, /Somebody has to fill it in/,
    '"the data is old" is a symptom; the row has to name the specific fix');
});
