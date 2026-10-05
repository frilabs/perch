import type { Principal } from '../auth/grants.js';
import { PerchError } from '../errors.js';
import { fanOut, type FanOutResult } from '../fanout.js';
import type { CredentialStore, GoogleProductivityAccount } from '../store/credentialStore.js';
import { UpstreamError, type CallOptions, type Upstream } from '../upstream.js';
import { assertTimestamp, assertTimeZone } from './calendarTime.js';
import { assertSelfOnlyEvent, buildCreateBody, buildPatchBody, parseCreateInput, parseUpdateInput } from './calendarWrite.js';
import { bounded, ProductivityAccess, type ProductivityTokenSource } from './productivityAccess.js';

/**
 * Google Calendar v3 (https://developers.google.com/workspace/calendar/api/v3/reference):
 * calendarList.list (maxResults default 100, max 250), events.list (default 250, max 2500; orderBy
 * startTime only with singleEvents=true; timeMin/timeMax RFC 3339 with offset), events.get.
 */

export const DEFAULT_CALENDAR_PAGE_SIZE = 25;
export const MAX_CALENDAR_PAGE_SIZE = 100;
/** Descriptions are free text (may contain HTML); bounded per event in tool output. */
export const MAX_DESCRIPTION_CHARS = 8192;
const MAX_ATTENDEES_SHOWN = 50;

const CALENDAR_ID = /^(?=.{1,255}$)[A-Za-z0-9._+#-]+(?:@[A-Za-z0-9._-]+)?$/;
/** Same shape as the Upstream allowlist: base32hex plus optional recurring-instance suffix. */
const EVENT_ID = /^(?!import$|quickAdd$|watch$)[a-v0-9]{5,1024}(?:_[0-9]{8}(?:T[0-9]{6}Z)?)?$/;

export function checkCalendarId(id: string): string {
  if (!CALENDAR_ID.test(id) || id.includes('..')) throw new PerchError('Invalid calendar id (use primary or an id from calendar_list_calendars)', 'bad_argument');
  return id;
}

export function checkEventId(id: string): string {
  if (!EVENT_ID.test(id)) throw new PerchError('Invalid event id (use an eventId returned by Perch)', 'bad_argument');
  return id;
}

export const eventsPath = (calendarId: string) => `/calendar/v3/calendars/${encodeURIComponent(checkCalendarId(calendarId))}/events`;
export const eventPath = (calendarId: string, eventId: string) => `${eventsPath(calendarId)}/${checkEventId(eventId)}`;

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface Person {
  email?: string;
  displayName?: string;
  self?: boolean;
}

export interface GoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  start?: EventTime;
  end?: EventTime;
  recurringEventId?: string;
  originalStartTime?: EventTime;
  organizer?: Person;
  creator?: Person;
  attendees?: Array<Person & { responseStatus?: string; optional?: boolean; organizer?: boolean; resource?: boolean }>;
  eventType?: string;
  visibility?: string;
  transparency?: string;
  hangoutLink?: string;
  reminders?: { useDefault?: boolean; overrides?: Array<{ method?: string; minutes?: number }> };
}

export interface CalendarEvent {
  calendarId: string;
  eventId: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  descriptionTruncated?: true;
  location?: string;
  allDay: boolean;
  start?: EventTime;
  end?: EventTime;
  /** All-day events: end.date is the day after the last day (exclusive). */
  endExclusive?: true;
  calendarTimeZone?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  originalStartTime?: EventTime;
  organizer?: Person;
  creator?: Person;
  attendees?: Array<Record<string, unknown>>;
  attendeesOmitted?: number;
  eventType?: string;
  visibility?: string;
  transparency?: string;
  hangoutLink?: string;
  reminders?: GoogleEvent['reminders'];
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function time(t: EventTime | undefined): EventTime | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const out: EventTime = {};
  if (str(t.date)) out.date = t.date!;
  if (str(t.dateTime)) out.dateTime = t.dateTime!;
  if (str(t.timeZone)) out.timeZone = t.timeZone!;
  return out;
}

function person(p: Person | undefined): Person | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const out: Person = {};
  if (str(p.email)) out.email = p.email!;
  if (str(p.displayName)) out.displayName = p.displayName!;
  if (p.self === true) out.self = true;
  return out;
}

/** Normalised event: start/end exactly as Google sent them, plus allDay/endExclusive and bounded text. */
export function toEvent(e: GoogleEvent, calendarId: string, calendarTimeZone?: string): CalendarEvent {
  const start = time(e.start);
  const allDay = !!start?.date && !start.dateTime;
  const out: CalendarEvent = { calendarId, eventId: str(e.id) ?? '', allDay };
  const copy = ['etag', 'status', 'summary', 'location', 'htmlLink', 'created', 'updated', 'recurringEventId', 'eventType', 'visibility', 'transparency', 'hangoutLink'] as const;
  for (const k of copy) if (str(e[k])) out[k] = e[k]!;
  if (str(e.description)) {
    out.description = e.description!.length > MAX_DESCRIPTION_CHARS ? e.description!.slice(0, MAX_DESCRIPTION_CHARS) : e.description!;
    if (e.description!.length > MAX_DESCRIPTION_CHARS) out.descriptionTruncated = true;
  }
  if (start) out.start = start;
  const end = time(e.end);
  if (end) out.end = end;
  if (allDay) out.endExclusive = true;
  if (calendarTimeZone) out.calendarTimeZone = calendarTimeZone;
  const ost = time(e.originalStartTime);
  if (ost) out.originalStartTime = ost;
  const organizer = person(e.organizer);
  if (organizer) out.organizer = organizer;
  const creator = person(e.creator);
  if (creator) out.creator = creator;
  if (Array.isArray(e.attendees)) {
    out.attendees = e.attendees.slice(0, MAX_ATTENDEES_SHOWN).map((a) => {
      const r: Record<string, unknown> = { ...person(a) };
      if (str(a.responseStatus)) r.responseStatus = a.responseStatus;
      if (a.optional === true) r.optional = true;
      if (a.organizer === true) r.organizer = true;
      if (a.resource === true) r.resource = true;
      return r;
    });
    if (e.attendees.length > MAX_ATTENDEES_SHOWN) out.attendeesOmitted = e.attendees.length - MAX_ATTENDEES_SHOWN;
  }
  if (e.reminders && typeof e.reminders === 'object') out.reminders = e.reminders;
  return out;
}

export interface CalendarSummary {
  calendarId: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: true;
}

export interface Provenance {
  accountId: string;
  accountLabel: string;
  email: string;
  provider: 'google';
}

export const provenance = (a: GoogleProductivityAccount): Provenance => ({ accountId: a.id, accountLabel: a.label, email: a.email, provider: 'google' });

export interface ListEventsOptions {
  accountId?: string;
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  query?: string;
  timeZone?: string;
  pageSize?: number;
  cursor?: string;
}

const NO_NOTIFY_NOTE =
  'No invitations or updates were sent to anyone (no attendees; sendUpdates=none). The event is private (visibility private/confidential) ' +
  'with popup reminders only, never calendar default or email reminders. Accepted by Google; that is not a sync or delivery confirmation for other devices.';

export interface CreateEventResult extends Provenance {
  status: 'created' | 'conflict' | 'rejected' | 'indeterminate';
  requestId: string;
  calendarId: string;
  eventId: string;
  event?: CalendarEvent;
  detail: string;
}

export interface UpdateEventResult extends Provenance {
  status: 'updated' | 'precondition_failed' | 'rejected' | 'indeterminate';
  calendarId: string;
  eventId: string;
  event?: CalendarEvent;
  currentEtag?: string;
  detail: string;
}

type WriteOutcome = { ok: true; body: Buffer } | { ok: false; status: number; message: string } | { ok: false; status: 'unknown' };

/** Splits `<base64url timeMin>.<fan-out cursor>`; an explicit timeMin must match the cursor's. */
function splitEventsCursor(cursor: string | undefined, explicit: string | undefined): { timeMin: string; inner?: string } {
  if (!cursor) return { timeMin: explicit ?? new Date().toISOString() };
  const m = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]+)$/.exec(cursor);
  const timeMin = m ? Buffer.from(m[1]!, 'base64url').toString('utf8') : '';
  if (!m || (explicit !== undefined && explicit !== timeMin)) throw new PerchError('Cursor does not belong to this query; repeat the same arguments', 'bad_cursor');
  return { timeMin, inner: m[2]! };
}

/** Calendar operations with provenance; every call is authorised before any provider I/O. */
export class CalendarService {
  protected readonly access: ProductivityAccess;

  constructor(
    protected readonly store: CredentialStore,
    protected readonly upstream: Upstream,
    tokens: ProductivityTokenSource,
  ) {
    this.access = new ProductivityAccess(store, tokens);
  }

  /** Authorised JSON call; a 401 drops the cached access token (never retried here). */
  protected async call<T>(account: GoogleProductivityAccount, cap: 'calendar_read' | 'calendar_write', opts: Omit<CallOptions, 'headers'>, extra: Record<string, string> = {}): Promise<T> {
    const headers = { ...(await this.access.authHeaders(account, cap)), ...extra };
    try {
      return await this.upstream.json<T>('calendar', { ...opts, headers });
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) this.access.invalidate(account.id);
      throw err;
    }
  }

  private async targets(principal: Principal, accountId: string | undefined): Promise<GoogleProductivityAccount[]> {
    return accountId ? [await this.access.account(principal, accountId, 'calendar_read')] : this.access.readable(principal, 'calendar_read');
  }

  async listCalendars(principal: Principal, opts: { accountId?: string; pageSize?: number; cursor?: string }): Promise<FanOutResult<CalendarSummary & Provenance>> {
    const pageSize = bounded('pageSize', opts.pageSize, DEFAULT_CALENDAR_PAGE_SIZE, MAX_CALENDAR_PAGE_SIZE);
    const targets = await this.targets(principal, opts.accountId);
    const byId = new Map(targets.map((a) => [a.id, a]));
    return fanOut({
      kind: 'calendars',
      queryKey: { s: pageSize, a: opts.accountId ?? '*' },
      sources: targets.map((a) => ({ id: a.id, label: a.label })),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      fetchPage: async (source, cursor) => {
        const account = byId.get(source.id)!;
        const res = await this.call<{ items?: Array<Record<string, unknown>>; nextPageToken?: string }>(account, 'calendar_read', {
          method: 'GET',
          path: '/calendar/v3/users/me/calendarList',
          query: { maxResults: pageSize, pageToken: cursor },
        });
        const items = (res.items ?? []).filter((c) => typeof c.id === 'string').map((c) => {
          const out: CalendarSummary & Provenance = { ...provenance(account), calendarId: c.id as string };
          for (const k of ['summary', 'description', 'timeZone', 'accessRole'] as const) if (str(c[k])) out[k] = c[k] as string;
          if (c.primary === true) out.primary = true;
          return out;
        });
        return { items, ...(res.nextPageToken ? { next: res.nextPageToken } : {}) };
      },
    });
  }

  async listEvents(principal: Principal, opts: ListEventsOptions): Promise<FanOutResult<CalendarEvent & Provenance>> {
    const pageSize = bounded('pageSize', opts.pageSize, DEFAULT_CALENDAR_PAGE_SIZE, MAX_CALENDAR_PAGE_SIZE);
    if (opts.calendarId !== undefined && !opts.accountId) throw new PerchError('calendarId requires accountId', 'bad_argument');
    const calendarId = checkCalendarId(opts.calendarId ?? 'primary');
    // Without timeMin, events.list starts at the beginning of time; Perch lists upcoming events by default.
    // Google requires identical parameters on every page, so the effective timeMin travels in the cursor.
    const { timeMin, inner } = splitEventsCursor(opts.cursor, opts.timeMin);
    const min = assertTimestamp('timeMin', timeMin);
    if (opts.timeMax !== undefined && assertTimestamp('timeMax', opts.timeMax) <= min) throw new PerchError('timeMax must be after timeMin', 'bad_argument');
    if (opts.timeZone !== undefined) assertTimeZone('timeZone', opts.timeZone);
    if (opts.query !== undefined && opts.query.length > 500) throw new PerchError('query must be at most 500 characters', 'bad_argument');
    const targets = await this.targets(principal, opts.accountId);
    const byId = new Map(targets.map((a) => [a.id, a]));
    const page = await fanOut({
      kind: 'events',
      // timeMin is part of the query: a default "now" is fixed into the cursor's first page.
      queryKey: { c: calendarId, a: opts.accountId ?? '*', s: pageSize, q: opts.query ?? '', tz: opts.timeZone ?? '', min: timeMin, max: opts.timeMax ?? '' },
      sources: targets.map((a) => ({ id: a.id, label: a.label })),
      ...(inner ? { cursor: inner } : {}),
      fetchPage: async (source, cursor) => {
        const account = byId.get(source.id)!;
        const res = await this.call<{ items?: GoogleEvent[]; nextPageToken?: string; timeZone?: string }>(account, 'calendar_read', {
          method: 'GET',
          path: eventsPath(calendarId),
          query: {
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: pageSize,
            pageToken: cursor,
            // Google requires all other parameters to stay identical across pages.
            timeMin,
            timeMax: opts.timeMax,
            q: opts.query || undefined,
            timeZone: opts.timeZone,
          },
        });
        const tz = str(res.timeZone);
        const items = (res.items ?? []).map((e) => ({ ...provenance(account), ...toEvent(e, calendarId, tz) }));
        return { items, ...(res.nextPageToken ? { next: res.nextPageToken } : {}) };
      },
    });
    return { ...page, nextCursor: page.nextCursor && `${Buffer.from(timeMin).toString('base64url')}.${page.nextCursor}` };
  }

  async getEvent(principal: Principal, opts: { accountId: string; calendarId: string; eventId: string; timeZone?: string }): Promise<CalendarEvent & Provenance> {
    const path = eventPath(opts.calendarId, opts.eventId);
    if (opts.timeZone !== undefined) assertTimeZone('timeZone', opts.timeZone);
    const account = await this.access.account(principal, opts.accountId, 'calendar_read');
    const e = await this.call<GoogleEvent>(account, 'calendar_read', { method: 'GET', path, ...(opts.timeZone ? { query: { timeZone: opts.timeZone } } : {}) });
    return { ...provenance(account), ...toEvent(e, opts.calendarId) };
  }

  /**
   * Exactly one request, never retried: after a lost response Perch cannot know whether Google applied
   * it. Failures before the request reaches the transport (validation, grant, token, allowlist) throw.
   */
  private async write(account: GoogleProductivityAccount, opts: Omit<CallOptions, 'headers' | 'capability'>, extra: Record<string, string> = {}): Promise<WriteOutcome> {
    const headers = { ...(await this.access.authHeaders(account, 'calendar_write')), ...extra };
    try {
      const res = await this.upstream.raw('calendar', { ...opts, headers, capability: 'calendar_write' });
      return { ok: true, body: res.body };
    } catch (err) {
      if (err instanceof PerchError && err.code === 'route_not_allowed') throw err;
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) {
        if (err.status === 401) this.access.invalidate(account.id);
        return { ok: false, status: err.status, message: err.message };
      }
      return { ok: false, status: 'unknown' };
    }
  }

  /**
   * events.insert with a requestId-derived event id and sendUpdates=none. Idempotency: the same
   * (accountId, calendarId as given, requestId) always yields the same id, so a manual retry after an
   * indeterminate outcome either creates the event once or gets 409 ("conflict"). Google notes that id
   * collisions may not always be detected at creation time, so "created" twice is not impossible.
   */
  async createEvent(principal: Principal, raw: Record<string, unknown>): Promise<CreateEventResult> {
    const input = parseCreateInput(raw);
    const account = await this.access.account(principal, input.accountId, 'calendar_write');
    const body = buildCreateBody(input);
    const base = { ...provenance(account), requestId: input.requestId, calendarId: input.calendarId, eventId: body.id };
    const out = await this.write(account, { method: 'POST', path: eventsPath(input.calendarId), query: { sendUpdates: 'none' }, json: body });
    if (out.ok) {
      const event = parseEventBody(out.body);
      return { ...base, status: 'created', ...(event ? { event: toEvent(event, input.calendarId) } : {}), detail: `Created. ${NO_NOTIFY_NOTE}` };
    }
    if (out.status === 409) {
      return {
        ...base,
        status: 'conflict',
        detail:
          'An event with this requestId already exists in this calendar (an earlier call, possibly one whose response was lost, created it; ' +
          'ids of deleted events stay taken). Nothing new was created. Inspect it with calendar_get_event; use a new requestId for a different event.',
      };
    }
    if (out.status === 'unknown') {
      return {
        ...base,
        status: 'indeterminate',
        detail:
          'Outcome unknown (network error, timeout or Google server error after the request was sent); Perch did not retry. Check with ' +
          'calendar_get_event using this eventId, or call calendar_create_event again with the same requestId and calendarId: it then either creates the event once or reports conflict.',
      };
    }
    return { ...base, status: 'rejected', detail: `Not created: ${out.message}` };
  }

  /**
   * events.patch with the caller's ETag in If-Match and sendUpdates=none, only for private events the
   * user organises (no guests, no series). Needs calendar_write and calendar_read (the existing event is
   * checked first and the updated event is returned).
   */
  async updateEvent(principal: Principal, raw: Record<string, unknown>): Promise<UpdateEventResult> {
    const input = parseUpdateInput(raw);
    const account = await this.access.account(principal, input.accountId, 'calendar_write');
    await this.access.account(principal, input.accountId, 'calendar_read');
    const path = eventPath(input.calendarId, input.eventId);
    const base = { ...provenance(account), calendarId: input.calendarId, eventId: input.eventId };
    const existing = await this.call<GoogleEvent & { recurrence?: unknown }>(account, 'calendar_read', { method: 'GET', path });
    if (existing.etag !== input.etag) {
      return {
        ...base,
        status: 'precondition_failed',
        ...(str(existing.etag) ? { currentEtag: existing.etag } : {}),
        detail: 'The event changed since you read it (etag mismatch); nothing was changed. Read it again and reapply your change.',
      };
    }
    assertSelfOnlyEvent(existing);
    const body = buildPatchBody(input, existing);
    const out = await this.write(account, { method: 'PATCH', path, query: { sendUpdates: 'none' }, json: body }, { 'if-match': input.etag });
    if (out.ok) {
      const event = parseEventBody(out.body);
      return { ...base, status: 'updated', ...(event ? { event: toEvent(event, input.calendarId) } : {}), detail: `Updated. ${NO_NOTIFY_NOTE}` };
    }
    if (out.status === 412) {
      return { ...base, status: 'precondition_failed', detail: 'The event changed just before the update (HTTP 412); nothing was changed. Read it again and reapply.' };
    }
    if (out.status === 'unknown') {
      return {
        ...base,
        status: 'indeterminate',
        detail:
          'Outcome unknown (network error, timeout or Google server error after the request was sent); Perch did not retry. Read the event with ' +
          'calendar_get_event: a new etag with your values means it was applied; the old etag means it was not.',
      };
    }
    return { ...base, status: 'rejected', detail: `Not updated: ${out.message}` };
  }
}

function parseEventBody(body: Buffer): GoogleEvent | undefined {
  try {
    const v = JSON.parse(body.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as GoogleEvent) : undefined;
  } catch {
    return undefined;
  }
}
