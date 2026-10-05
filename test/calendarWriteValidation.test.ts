// Constrained calendar write subset: schema, forbidden fields (no invitations/notifications), dates and
// time zones, size bounds, deterministic event ids from requestId, and the "private/self event" check.
// Pure functions; no upstream.
import { describe, expect, it } from 'vitest';
import {
  assertSelfOnlyEvent,
  buildCreateBody,
  buildPatchBody,
  eventIdForRequest,
  MAX_DESCRIPTION_LENGTH,
  parseCreateInput,
  parseUpdateInput,
  validateTimes,
} from '../src/google/calendarWrite.js';
import { assertTimestamp, instantOf, parseDateTime } from '../src/google/calendarTime.js';

const base = {
  accountId: 'gprod-0000000a',
  requestId: 'req-2026-10-05-0001',
  summary: 'Dentist',
  start: { dateTime: '2026-10-06T09:00:00', timeZone: 'Europe/Vienna' },
  end: { dateTime: '2026-10-06T10:00:00', timeZone: 'Europe/Vienna' },
};

describe('parseCreateInput', () => {
  it('accepts the documented subset and defaults calendarId to primary', () => {
    const v = parseCreateInput({
      ...base,
      description: 'Bring card',
      location: 'Vienna',
      transparency: 'transparent',
      visibility: 'private',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    });
    expect(v.calendarId).toBe('primary');
    expect(v.summary).toBe('Dentist');
  });

  it('rejects every invitation/notification/sharing field with an explicit reason', () => {
    for (const field of ['attendees', 'organizer', 'conferenceData', 'attachments', 'guestsCanInviteOthers', 'anyoneCanAddSelf', 'sendUpdates', 'recurrence', 'source', 'extendedProperties', 'id', 'iCalUID', 'acl']) {
      expect(() => parseCreateInput({ ...base, [field]: field === 'attendees' ? [{ email: 'x@example.test' }] : 'x' }), field).toThrow(
        new RegExp(`${field}.*not supported`, 'i'),
      );
    }
    expect(() => parseCreateInput({ ...base, colour: 'red' })).toThrow(/unsupported field.*colour/i);
  });

  it('rejects email reminders (they send mail) and more than five overrides', () => {
    expect(() => parseCreateInput({ ...base, reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 10 }] } })).toThrow(/popup/i);
    expect(() =>
      parseCreateInput({ ...base, reminders: { useDefault: false, overrides: Array.from({ length: 6 }, () => ({ method: 'popup', minutes: 5 })) } }),
    ).toThrow(/5/);
    expect(() => parseCreateInput({ ...base, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 40321 }] } })).toThrow(/40320/);
  });

  it('rejects public visibility (it shares details with every calendar reader)', () => {
    expect(() => parseCreateInput({ ...base, visibility: 'public' })).toThrow(/visibility/i);
  });

  it('validates all-day and timed dates and time zones', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ start: { date: '2026-10-06' }, end: { dateTime: '2026-10-07T00:00:00Z' } }, /both all-day/i],
      [{ start: { date: '2026-10-06' }, end: { date: '2026-10-06' } }, /end.*after/i],
      [{ start: { date: '2026-02-29' }, end: { date: '2026-03-01' } }, /date/i],
      [{ start: { date: '2026-10-06', timeZone: 'Europe/Vienna' }, end: { date: '2026-10-07' } }, /timeZone/i],
      [{ start: { dateTime: '2026-10-06T09:00:00' }, end: { dateTime: '2026-10-06T10:00:00' } }, /offset.*timeZone/i],
      [{ start: { dateTime: '2026-10-06T09:00:00Z', timeZone: 'Mars/Base' }, end: { dateTime: '2026-10-06T10:00:00Z' } }, /time ?zone/i],
      [{ start: { dateTime: '2026-10-06T10:00:00+02:00' }, end: { dateTime: '2026-10-06T08:00:00Z' } }, /end.*after/i],
      [{ start: { dateTime: '2026-10-06T25:00:00Z' }, end: { dateTime: '2026-10-07T00:00:00Z' } }, /dateTime/i],
      [{ start: { date: '2026-01-01' }, end: { date: '2027-01-03' } }, /366/],
    ];
    for (const [times, re] of bad) expect(() => parseCreateInput({ ...base, ...times }), JSON.stringify(times)).toThrow(re);
    // Wall time in different zones: 09:30 Vienna (07:30Z) ends after 08:00 London (07:00Z)? No: it starts later.
    expect(() =>
      parseCreateInput({ ...base, start: { dateTime: '2026-10-06T09:30:00', timeZone: 'Europe/Vienna' }, end: { dateTime: '2026-10-06T08:00:00', timeZone: 'Europe/London' } }),
    ).toThrow(/end.*after/i);
    expect(() =>
      parseCreateInput({ ...base, start: { dateTime: '2026-10-06T09:30:00', timeZone: 'Europe/Vienna' }, end: { dateTime: '2026-10-06T09:00:00', timeZone: 'Europe/London' } }),
    ).not.toThrow();
    expect(() => parseCreateInput({ ...base, start: { date: '2026-10-06' }, end: { date: '2026-10-07' } })).not.toThrow();
  });

  it('bounds text lengths and requires a stable requestId', () => {
    expect(() => parseCreateInput({ ...base, summary: '' })).toThrow(/summary/i);
    expect(() => parseCreateInput({ ...base, summary: 'x'.repeat(1025) })).toThrow(/summary/i);
    expect(() => parseCreateInput({ ...base, description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) })).toThrow(/description/i);
    expect(() => parseCreateInput({ ...base, summary: 'a\u0000b' })).toThrow(/control/i);
    for (const requestId of [undefined, 'short', 'has space here', 'x'.repeat(129)]) {
      expect(() => parseCreateInput({ ...base, requestId }), String(requestId)).toThrow(/requestId/i);
    }
  });
});

describe('create: private and silent by construction (review blockers)', () => {
  it('sends visibility=private when none is given, so the event never inherits public calendar sharing', () => {
    expect(buildCreateBody(parseCreateInput(base)).visibility).toBe('private');
    expect(buildCreateBody(parseCreateInput({ ...base, visibility: 'private' })).visibility).toBe('private');
    // Google: "confidential: The event is private. This value is provided for compatibility reasons."
    expect(buildCreateBody(parseCreateInput({ ...base, visibility: 'confidential' })).visibility).toBe('confidential');
  });

  it("rejects visibility 'default' (inherits the calendar's sharing, which may be public) and 'public'", () => {
    expect(() => parseCreateInput({ ...base, visibility: 'default' })).toThrow(/visibility.*private or confidential/i);
    expect(() => parseCreateInput({ ...base, visibility: 'public' })).toThrow(/visibility.*private or confidential/i);
  });

  it('never inherits calendar default reminders (they may be email): absent -> {useDefault:false, overrides:[]}', () => {
    expect(buildCreateBody(parseCreateInput(base)).reminders).toEqual({ useDefault: false, overrides: [] });
    expect(buildCreateBody(parseCreateInput({ ...base, reminders: { useDefault: false } })).reminders).toEqual({ useDefault: false, overrides: [] });
    const popup = { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] };
    expect(buildCreateBody(parseCreateInput({ ...base, reminders: popup })).reminders).toEqual(popup);
  });

  it('rejects reminders.useDefault=true (calendar defaults may send email), also together with overrides', () => {
    expect(() => parseCreateInput({ ...base, reminders: { useDefault: true } })).toThrow(/useDefault.*false/i);
    expect(() => parseCreateInput({ ...base, reminders: { useDefault: true, overrides: [{ method: 'popup', minutes: 5 }] } })).toThrow(/useDefault.*false/i);
  });
});

describe('timed values in years 0001-0099 (Date.UTC maps 0-99 to 1900-1999)', () => {
  it('computes the real instant for full years below 100', () => {
    for (const s of ['0099-12-31T00:00:00Z', '0001-01-01T00:00:00Z', '0050-06-15T12:30:00+02:00']) {
      expect(instantOf(parseDateTime(s)!, undefined), s).toBe(Date.parse(s));
    }
    expect(assertTimestamp('timeMin', '0099-12-31T00:00:00Z')).toBe(Date.parse('0099-12-31T00:00:00Z'));
  });

  it('keeps the ordering and the 366-day maximum for such years', () => {
    expect(() => validateTimes({ dateTime: '0099-12-31T00:00:00Z' }, { dateTime: '1999-12-31T12:00:00Z' })).toThrow(/366/);
    expect(() => validateTimes({ dateTime: '1999-01-01T00:00:00Z' }, { dateTime: '0099-01-02T00:00:00Z' })).toThrow(/end.*after/i);
    expect(() => validateTimes({ dateTime: '0099-01-01T09:00:00Z' }, { dateTime: '0099-01-01T10:00:00Z' })).not.toThrow();
    // Wall time in a zone: two hours after a Z start in the same year 0050 (Vienna LMT is about +01:05).
    expect(() => validateTimes({ dateTime: '0050-03-01T10:00:00Z' }, { dateTime: '0050-03-01T09:00:00', timeZone: 'Europe/Vienna' })).toThrow(/end.*after/i);
    expect(() => validateTimes({ dateTime: '0050-03-01T10:00:00Z' }, { dateTime: '0050-03-01T13:00:00', timeZone: 'Europe/Vienna' })).not.toThrow();
    expect(() => validateTimes({ date: '0099-12-31' }, { date: '0100-01-01' })).not.toThrow();
  });
});

describe('deterministic event ids', () => {
  it('maps (account, calendar, requestId) to a legal, stable base32hex id', () => {
    const id = eventIdForRequest('gprod-0000000a', 'primary', 'req-2026-10-05-0001');
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(id).toBe(eventIdForRequest('gprod-0000000a', 'primary', 'req-2026-10-05-0001'));
    expect(id).not.toBe(eventIdForRequest('gprod-0000000a', 'primary', 'req-2026-10-05-0002'));
    expect(id).not.toBe(eventIdForRequest('gprod-0000000b', 'primary', 'req-2026-10-05-0001'));
  });

  it('builds a create body with only allowed fields plus the derived id', () => {
    const body = buildCreateBody(parseCreateInput({ ...base, description: 'd' }));
    expect(Object.keys(body).sort()).toEqual(['description', 'end', 'id', 'reminders', 'start', 'summary', 'visibility']);
    expect(body.id).toBe(eventIdForRequest('gprod-0000000a', 'primary', base.requestId));
  });
});

describe('updates', () => {
  const existing = {
    id: 'evt0timed002',
    etag: '"2"',
    status: 'confirmed',
    organizer: { email: 'dummy.a@example.test', self: true },
    start: { dateTime: '2026-10-06T09:00:00+02:00', timeZone: 'Europe/Vienna' },
    end: { dateTime: '2026-10-06T10:00:00+02:00', timeZone: 'Europe/Vienna' },
  };

  it('requires the etag and at least one change, and forbids the same fields as create', () => {
    const ok = { accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"', summary: 'New' };
    expect(parseUpdateInput(ok).etag).toBe('"2"');
    expect(() => parseUpdateInput({ ...ok, etag: undefined })).toThrow(/etag/i);
    expect(() => parseUpdateInput({ ...ok, etag: 'W/"x"\r\n' })).toThrow(/etag/i);
    expect(() => parseUpdateInput({ accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"' })).toThrow(/at least one/i);
    expect(() => parseUpdateInput({ ...ok, attendees: [] })).toThrow(/attendees.*not supported/i);
    expect(() => parseUpdateInput({ ...ok, eventId: '../x' })).toThrow(/event id/i);
  });

  it('validates a partial time change against the existing event', () => {
    const later = parseUpdateInput({ accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"', start: { dateTime: '2026-10-06T11:00:00+02:00' } });
    expect(() => buildPatchBody(later, existing)).toThrow(/end.*after/i);
    const allDayStartOnly = parseUpdateInput({ accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"', start: { date: '2026-10-06' } });
    expect(() => buildPatchBody(allDayStartOnly, existing)).toThrow(/both all-day/i);
    const fine = parseUpdateInput({ accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"', summary: 'Moved', location: 'Graz' });
    expect(buildPatchBody(fine, { ...existing, visibility: 'private', reminders: { useDefault: false, overrides: [] } })).toEqual({ summary: 'Moved', location: 'Graz' });
  });

  it('only touches private/self events: no guests, not organised by someone else, no series, no special types', () => {
    expect(() => assertSelfOnlyEvent(existing)).not.toThrow();
    expect(() => assertSelfOnlyEvent({ ...existing, attendees: [{ email: 'dummy.a@example.test', self: true }] })).not.toThrow();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ attendees: [{ email: 'guest@example.test' }] }, /guests/i],
      [{ organizer: { email: 'boss@example.test' } }, /organi[sz]ed by someone else/i],
      [{ recurrence: ['RRULE:FREQ=WEEKLY'] }, /recurring/i],
      [{ recurringEventId: 'abcde12345' }, /recurring/i],
      [{ eventType: 'outOfOffice' }, /type/i],
      [{ status: 'cancelled' }, /cancelled/i],
    ];
    for (const [change, re] of cases) {
      expect(() => assertSelfOnlyEvent({ ...existing, ...change }), JSON.stringify(change)).toThrow(re);
    }
  });

  it('fails closed when the existing event has no organizer or no organizer.self', () => {
    const { organizer: _o, ...noOrganizer } = existing;
    expect(() => assertSelfOnlyEvent(noOrganizer)).toThrow(/organizer/i);
    expect(() => assertSelfOnlyEvent({ status: 'confirmed' })).toThrow(/organizer/i);
    expect(() => assertSelfOnlyEvent({ ...existing, organizer: { email: 'dummy.a@example.test' } })).toThrow(/organi[sz]e/i);
  });

  const safe = { visibility: 'private', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] } };
  const summaryOnly = () => parseUpdateInput({ accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"', summary: 'S' });

  it('makes the result private in the same PATCH when the existing event is public, default or unset', () => {
    for (const visibility of ['public', 'default', undefined]) {
      expect(buildPatchBody(summaryOnly(), { ...existing, ...safe, visibility }), String(visibility)).toEqual({ summary: 'S', visibility: 'private' });
    }
    expect(buildPatchBody(summaryOnly(), { ...existing, ...safe })).toEqual({ summary: 'S' });
    expect(buildPatchBody(summaryOnly(), { ...existing, ...safe, visibility: 'confidential' })).toEqual({ summary: 'S' });
    const conf = parseUpdateInput({ accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"', visibility: 'confidential' });
    expect(buildPatchBody(conf, { ...existing, ...safe, visibility: 'public' })).toEqual({ visibility: 'confidential' });
  });

  it("rejects update visibility 'default'/'public' and reminders.useDefault=true", () => {
    const ok = { accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"' };
    expect(() => parseUpdateInput({ ...ok, visibility: 'default' })).toThrow(/visibility.*private or confidential/i);
    expect(() => parseUpdateInput({ ...ok, visibility: 'public' })).toThrow(/visibility.*private or confidential/i);
    expect(() => parseUpdateInput({ ...ok, reminders: { useDefault: true } })).toThrow(/useDefault.*false/i);
  });

  it('disables inherited/default and email reminders in the same PATCH, keeping only popup overrides', () => {
    const vis = { visibility: 'private' };
    const cases: Array<[unknown, unknown]> = [
      [undefined, { useDefault: false, overrides: [] }],
      [{ useDefault: true }, { useDefault: false, overrides: [] }],
      [{}, { useDefault: false, overrides: [] }],
      [{ useDefault: false, overrides: [{ method: 'email', minutes: 30 }, { method: 'popup', minutes: 5 }] }, { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] }],
      [{ useDefault: false, overrides: [{ method: 'popup', minutes: 'x' }] }, { useDefault: false, overrides: [] }],
    ];
    for (const [reminders, expected] of cases) {
      expect(buildPatchBody(summaryOnly(), { ...existing, ...vis, reminders } as never), JSON.stringify(reminders)).toEqual({ summary: 'S', reminders: expected });
    }
    // Already safe: untouched.
    expect(buildPatchBody(summaryOnly(), { ...existing, ...safe })).toEqual({ summary: 'S' });
    expect(buildPatchBody(summaryOnly(), { ...existing, ...vis, reminders: { useDefault: false } })).toEqual({ summary: 'S' });
    // An explicit popup array replaces everything; overrides are always sent so a PATCH merge cannot keep old email overrides.
    const explicit = parseUpdateInput({ accountId: 'gprod-0000000a', calendarId: 'primary', eventId: 'evt0timed002', etag: '"2"', reminders: { useDefault: false } });
    expect(buildPatchBody(explicit, { ...existing, ...vis, reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1 }] } })).toEqual({
      reminders: { useDefault: false, overrides: [] },
    });
  });
});
