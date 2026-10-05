import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PerchError } from '../errors.js';
import { checkCalendarId, checkEventId, type EventTime, type GoogleEvent } from './calendar.js';
import { instantOf, isValidDate, isValidTimeZone, parseDateTime, utcMs } from './calendarTime.js';

/**
 * The constrained calendar write subset of this milestone. Private events on the user's own calendars:
 * - fields: summary, description, location, start, end, transparency, visibility (private or
 *   confidential only), reminders (up to 5 popup overrides, never the calendar defaults);
 * - private and silent by construction: create always sends an explicit visibility (default private)
 *   and reminders {useDefault:false, overrides:[popup…]}, because visibility "default" inherits the
 *   calendar's sharing (which may be public) and the calendar default reminders may be email. An update
 *   adds visibility:"private" and/or popup-only reminders to the same PATCH when the existing event is
 *   not already private/confidential and popup-only;
 * - never: attendees, organizer, conference data, attachments, recurrence, guest permissions, source
 *   URLs, extended properties, caller-chosen ids, event types, status;
 * - every write is sent with sendUpdates=none and without conferenceDataVersion/supportsAttachments.
 * Field semantics: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
 */

export const MAX_SUMMARY_LENGTH = 1024;
export const MAX_DESCRIPTION_LENGTH = 8192;
export const MAX_LOCATION_LENGTH = 1024;
export const MAX_EVENT_BODY_BYTES = 16 * 1024;
export const MAX_EVENT_DAYS = 366;
/** Google: "The maximum number of override reminders is 5"; minutes "between 0 and 40320". */
const MAX_REMINDERS = 5;
const MAX_REMINDER_MINUTES = 40320;
const DAY_MS = 86_400_000;

/** Fields that would invite, notify, share or otherwise reach beyond a private event. */
const FORBIDDEN: Record<string, string> = {
  attendees: 'no invitations are sent in this milestone',
  organizer: 'the organizer is always the calendar owner',
  creator: 'set by Google',
  conferenceData: 'no conferences are created',
  hangoutLink: 'no conferences are created',
  attachments: 'no attachment URLs',
  recurrence: 'only single events are supported',
  recurringEventId: 'only single events are supported',
  guestsCanInviteOthers: 'there are no guests',
  guestsCanModify: 'there are no guests',
  guestsCanSeeOtherGuests: 'there are no guests',
  anyoneCanAddSelf: 'there are no guests',
  sendUpdates: 'Perch always sends sendUpdates=none',
  sendNotifications: 'Perch always sends sendUpdates=none',
  source: 'no source URLs',
  extendedProperties: 'not part of this subset',
  gadget: 'not part of this subset',
  id: 'the event id is derived from requestId',
  iCalUID: 'the event id is derived from requestId',
  eventType: 'only default events',
  status: 'deleting/cancelling is not supported',
  sequence: 'managed by Google',
  acl: 'calendar sharing is never changed',
  workingLocationProperties: 'only default events',
  outOfOfficeProperties: 'only default events',
  focusTimeProperties: 'only default events',
  birthdayProperties: 'only default events',
};

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
/** HTTP entity tag as returned by Calendar ("…" or W/"…"), printable ASCII only. */
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;

const text = (name: string, max: number, min = 0) =>
  z
    .string({ error: `${name} must be a string` })
    .min(min, `${name} must not be empty`)
    .max(max, `${name} must be at most ${max} characters`)
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), `${name} must not contain control characters`);

const TimeSchema = z.strictObject({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() });

const RemindersSchema = z.strictObject({
  useDefault: z.literal(false, { error: 'reminders.useDefault must be false: calendar default reminders may send email; give popup overrides instead' }),
  overrides: z
    .array(
      z.strictObject({
        method: z.literal('popup', { error: 'Only popup reminders are supported (email reminders send mail)' }),
        minutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES, `Reminder minutes must be between 0 and ${MAX_REMINDER_MINUTES}`),
      }),
    )
    .max(MAX_REMINDERS, `At most ${MAX_REMINDERS} reminder overrides`)
    .optional(),
});

const fields = {
  summary: text('summary', MAX_SUMMARY_LENGTH, 1),
  description: text('description', MAX_DESCRIPTION_LENGTH).optional(),
  location: text('location', MAX_LOCATION_LENGTH).optional(),
  transparency: z.enum(['opaque', 'transparent']).optional(),
  visibility: z
    .enum(['private', 'confidential'], {
      error: 'visibility must be private or confidential ("default" inherits the calendar sharing, which may be public; public is not supported)',
    })
    .optional(),
  reminders: RemindersSchema.optional(),
};

const CreateSchema = z.strictObject({
  accountId: z.string().max(64),
  calendarId: z.string().max(255).optional(),
  requestId: z.string({ error: 'requestId is required (a stable id you reuse when retrying)' }).regex(REQUEST_ID, 'requestId must be 8-128 characters of A-Z a-z 0-9 . _ : -'),
  ...fields,
  start: TimeSchema,
  end: TimeSchema,
});

const UpdateSchema = z.strictObject({
  accountId: z.string().max(64),
  calendarId: z.string().max(255),
  eventId: z.string().max(1100),
  etag: z.string({ error: 'etag is required (from calendar_get_event or calendar_list_events)' }).regex(ETAG, 'etag must be the event etag returned by Perch, e.g. "3181161784712000"'),
  summary: fields.summary.optional(),
  description: fields.description,
  location: fields.location,
  transparency: fields.transparency,
  visibility: fields.visibility,
  reminders: fields.reminders,
  start: TimeSchema.optional(),
  end: TimeSchema.optional(),
});

type Reminders = { useDefault: false; overrides: Array<{ method: 'popup'; minutes: number }> };
export type CreateInput = Omit<z.infer<typeof CreateSchema>, 'visibility' | 'reminders'> & {
  calendarId: string;
  visibility: 'private' | 'confidential';
  reminders: Reminders;
};
export type UpdateInput = Omit<z.infer<typeof UpdateSchema>, 'reminders'> & { reminders?: Reminders };

/** Overrides are always explicit: a PATCH merges nested objects, so an omitted array would keep old (email) overrides. */
const reminders = (r: { useDefault: false; overrides?: Reminders['overrides'] } | undefined): Reminders | undefined =>
  r && { useDefault: false, overrides: r.overrides ?? [] };

function rejectForbidden(raw: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && k in FORBIDDEN) throw new PerchError(`${k} is not supported: ${FORBIDDEN[k]}`, 'bad_argument');
  }
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PerchError('Expected an object', 'bad_argument');
  // Undefined optional keys (e.g. from the MCP layer) are not "present".
  const clean = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== undefined));
  rejectForbidden(clean);
  const r = schema.safeParse(clean);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  if (issue.code === 'unrecognized_keys') throw new PerchError(`Unsupported field: ${issue.keys.join(', ')}`, 'bad_argument');
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw new PerchError(`${where}${issue.message}`, 'bad_argument');
}

type Point = { allDay: true; day: number } | { allDay: false; at: number };

function point(name: string, t: EventTime): Point {
  if (t.date !== undefined) {
    if (t.dateTime !== undefined || t.timeZone !== undefined) throw new PerchError(`${name}: an all-day time has only date (no dateTime/timeZone)`, 'bad_argument');
    if (!isValidDate(t.date)) throw new PerchError(`${name}.date must be a valid yyyy-mm-dd date`, 'bad_argument');
    const [y, mo, d] = t.date.split('-').map(Number);
    return { allDay: true, day: utcMs(y!, mo!, d!) };
  }
  if (t.dateTime === undefined) throw new PerchError(`${name} needs date (all-day) or dateTime`, 'bad_argument');
  const p = parseDateTime(t.dateTime);
  if (!p) throw new PerchError(`${name}.dateTime must be RFC 3339, e.g. 2026-10-06T09:00:00+02:00`, 'bad_argument');
  if (t.timeZone !== undefined && !isValidTimeZone(t.timeZone)) throw new PerchError(`${name}.timeZone must be an IANA time zone name such as Europe/Vienna`, 'bad_argument');
  if (!p.offset && t.timeZone === undefined) throw new PerchError(`${name}.dateTime needs an offset (Z or ±hh:mm) or a timeZone`, 'bad_argument');
  return { allDay: false, at: instantOf(p, t.timeZone) };
}

/** Both all-day or both timed; end strictly after start; at most MAX_EVENT_DAYS long. */
export function validateTimes(start: EventTime, end: EventTime): void {
  const s = point('start', start);
  const e = point('end', end);
  if (s.allDay !== e.allDay) throw new PerchError('start and end must be both all-day (date) or both timed (dateTime)', 'bad_argument');
  const a = s.allDay ? s.day : s.at;
  const b = e.allDay ? (e as { day: number }).day : (e as { at: number }).at;
  if (b <= a) throw new PerchError(s.allDay ? 'end must be after start (all-day end dates are exclusive: the day after the last day)' : 'end must be after start', 'bad_argument');
  if (b - a > MAX_EVENT_DAYS * DAY_MS) throw new PerchError(`Events may be at most ${MAX_EVENT_DAYS} days long`, 'bad_argument');
}

export function parseCreateInput(raw: unknown): CreateInput {
  const v = parse(CreateSchema, raw);
  const calendarId = checkCalendarId(v.calendarId ?? 'primary');
  validateTimes(v.start, v.end);
  return { ...v, calendarId, visibility: v.visibility ?? 'private', reminders: reminders(v.reminders) ?? { useDefault: false, overrides: [] } };
}

export function parseUpdateInput(raw: unknown): UpdateInput {
  const v = parse(UpdateSchema, raw);
  checkCalendarId(v.calendarId);
  checkEventId(v.eventId);
  const changes = ['summary', 'description', 'location', 'transparency', 'visibility', 'reminders', 'start', 'end'] as const;
  if (!changes.some((k) => v[k] !== undefined)) throw new PerchError(`Give at least one field to change (${changes.join(', ')})`, 'bad_argument');
  const { reminders: r, ...rest } = v;
  return { ...rest, ...(r ? { reminders: reminders(r) } : {}) };
}

/** base32hex (RFC 4648 §7) in lowercase: exactly the documented Calendar event id alphabet a-v, 0-9. */
function base32hex(buf: Buffer): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Deterministic event id for create: the same (account, calendarId as given, requestId) always maps to
 * the same id, so a retry after an unknown outcome cannot create a second event (Google answers 409).
 */
export function eventIdForRequest(accountId: string, calendarId: string, requestId: string): string {
  const digest = createHash('sha256').update(`perch-calendar-create\u0000${accountId}\u0000${calendarId}\u0000${requestId}`).digest();
  return `perch${base32hex(digest)}`;
}

function sizeChecked<T>(body: T): T {
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_EVENT_BODY_BYTES) throw new PerchError(`Event exceeds ${MAX_EVENT_BODY_BYTES} bytes`, 'bad_argument');
  return body;
}

function pick(v: Partial<CreateInput & UpdateInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['summary', 'description', 'location', 'start', 'end', 'transparency', 'visibility', 'reminders'] as const) if (v[k] !== undefined) out[k] = v[k];
  return out;
}

export function buildCreateBody(v: CreateInput): Record<string, unknown> & { id: string } {
  return sizeChecked({ id: eventIdForRequest(v.accountId, v.calendarId, v.requestId), ...pick(v) });
}

const isPrivate = (visibility: unknown) => visibility === 'private' || visibility === 'confidential';

/** The existing event's valid popup overrides; anything else (email, malformed) is dropped. */
function popupOverrides(r: GoogleEvent['reminders']): Reminders['overrides'] {
  const list = Array.isArray(r?.overrides) ? r.overrides : [];
  return list
    .filter((o) => o?.method === 'popup' && Number.isInteger(o.minutes) && o.minutes! >= 0 && o.minutes! <= MAX_REMINDER_MINUTES)
    .slice(0, MAX_REMINDERS)
    .map((o) => ({ method: 'popup', minutes: o.minutes! }));
}

/** Only an explicit useDefault:false with popup overrides only is silent; missing or default reminders may be email. */
function remindersAreSafe(r: GoogleEvent['reminders']): boolean {
  if (!r || typeof r !== 'object' || r.useDefault !== false) return false;
  const list = r.overrides ?? [];
  return Array.isArray(list) && list.length === popupOverrides(r).length;
}

/**
 * PATCH body: the changed fields, a single changed time validated against the existing event, plus
 * - visibility:"private" unless the caller sets one or the event is already private/confidential
 *   (an event with visibility public/default/unset would otherwise stay visible to calendar readers);
 * - reminders {useDefault:false, overrides:[existing popup overrides]} unless the caller sets them or
 *   the event already uses only popup overrides (default reminders and email overrides send mail).
 * Both go in the same PATCH as the change, so the result is never public or emailing.
 */
export function buildPatchBody(v: UpdateInput, existing: GoogleEvent): Record<string, unknown> {
  if (v.start || v.end) {
    const start = v.start ?? existing.start;
    const end = v.end ?? existing.end;
    if (!start || !end) throw new PerchError('The existing event has no start/end; give both', 'bad_argument');
    validateTimes(start, end);
  }
  const body = pick(v);
  if (body.visibility === undefined && !isPrivate(existing.visibility)) body.visibility = 'private';
  if (body.reminders === undefined && !remindersAreSafe(existing.reminders)) body.reminders = { useDefault: false, overrides: popupOverrides(existing.reminders) };
  return sizeChecked(body);
}

/**
 * Updates are limited to private events of the calendar owner: no guests other than the user, not
 * organised by someone else, no recurring series or instances, default event type, not cancelled.
 * Changing such an event with sendUpdates=none would otherwise silently desynchronise guests.
 */
export function assertSelfOnlyEvent(e: GoogleEvent & { recurrence?: unknown }): void {
  const no = (why: string) => new PerchError(`This event cannot be changed by Perch: ${why}. Nothing was changed.`, 'unsupported_event');
  if (e.status === 'cancelled') throw no('it is cancelled');
  if (!e.organizer) throw no('the event has no organizer, so Perch cannot confirm you organize it');
  if (e.organizer.self !== true) throw no('it is organized by someone else (or the organizer is not confirmed as you)');
  if (Array.isArray(e.attendees) && e.attendees.some((a) => a.self !== true)) throw no('it has guests (updates would not notify them)');
  if (e.recurrence !== undefined || e.recurringEventId !== undefined) throw no('it is part of a recurring series');
  if (e.eventType !== undefined && e.eventType !== 'default') throw no(`its type is ${e.eventType}`);
}
