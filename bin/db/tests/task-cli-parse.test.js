const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseDue, parseTime } = require('../task-cli.js');

// --- parseTime ---

describe('parseTime', () => {
  it('parses 12-hour times with am/pm', () => {
    assert.equal(parseTime('2pm'), '14:00');
    assert.equal(parseTime('9am'), '09:00');
    assert.equal(parseTime('12pm'), '12:00');
    assert.equal(parseTime('12am'), '00:00');
    assert.equal(parseTime('12:30pm'), '12:30');
    assert.equal(parseTime('12:30am'), '00:30');
    assert.equal(parseTime('1:15pm'), '13:15');
  });

  it('parses 24-hour times without am/pm', () => {
    assert.equal(parseTime('14:00'), '14:00');
    assert.equal(parseTime('0:00'), '00:00');
    assert.equal(parseTime('9:05'), '09:05');
    assert.equal(parseTime('23:59'), '23:59');
  });

  it('handles 13pm gracefully (military time with stray suffix)', () => {
    // 13 is not < 12, so +12 is skipped -> returns 13:00
    assert.equal(parseTime('13pm'), '13:00');
  });

  it('throws on unparseable input', () => {
    assert.throws(() => parseTime('noon'), /Cannot parse time/);
    assert.throws(() => parseTime(''), /Cannot parse time/);
  });
});

// --- parseDue ---

describe('parseDue', () => {
  it('returns null for falsy input', () => {
    assert.equal(parseDue(null), null);
    assert.equal(parseDue(undefined), null);
    assert.equal(parseDue(''), null);
  });

  it('passes through canonical date-only', () => {
    assert.equal(parseDue('2026-04-01'), '2026-04-01');
  });

  it('passes through canonical date+time', () => {
    assert.equal(parseDue('2026-04-01 14:00'), '2026-04-01 14:00');
  });

  it('parses "today" to current date', () => {
    const result = parseDue('today');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('parses "today at 2pm"', () => {
    const result = parseDue('today at 2pm');
    assert.match(result, /^\d{4}-\d{2}-\d{2} 14:00$/);
  });

  it('parses "today 14:00"', () => {
    const result = parseDue('today 14:00');
    assert.match(result, /^\d{4}-\d{2}-\d{2} 14:00$/);
  });

  it('parses "tomorrow"', () => {
    const result = parseDue('tomorrow');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
    // Tomorrow should be different from today
    assert.notEqual(result, parseDue('today'));
  });

  it('parses "tomorrow at 9am"', () => {
    const result = parseDue('tomorrow at 9am');
    assert.match(result, /^\d{4}-\d{2}-\d{2} 09:00$/);
  });

  it('parses "tomorrow 9:00"', () => {
    const result = parseDue('tomorrow 9:00');
    assert.match(result, /^\d{4}-\d{2}-\d{2} 09:00$/);
  });

  it('parses "YYYY-MM-DD at 2pm"', () => {
    assert.equal(parseDue('2026-04-01 at 2pm'), '2026-04-01 14:00');
  });

  it('is case-insensitive for today/tomorrow', () => {
    assert.match(parseDue('TODAY'), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(parseDue('Tomorrow at 3PM'), /^\d{4}-\d{2}-\d{2} 15:00$/);
  });

  it('passes through unsupported strings for toDueStr validation', () => {
    // These should pass through unchanged - toDueStr will reject them
    assert.equal(parseDue('next monday'), 'next monday');
    assert.equal(parseDue('friday'), 'friday');
  });
});
