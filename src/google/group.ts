import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  gmailScopesFor,
} from '../mail/gmailAccounts.js';
import type { CredentialStore, GoogleAccountGroup, StoreData } from '../store/credentialStore.js';
import { UpstreamError, type Upstream } from '../upstream.js';
import { detachGroupMember, findGroup, groupMembers, groupServices, type GoogleMemberSection } from './groupStore.js';
import {
  DRIVE_READONLY_SCOPE,
  DRIVE_SCOPE,
  revokeToken,
  runLoopbackAuthorization,
  type AuthorizationResult,
  type GoogleClientCredentials,
  type GoogleTokenResponse,
} from './oauth.js';
import {
  CALENDAR_EVENTS_OWNED_SCOPE,
  CALENDAR_READONLY_SCOPE,
  CONTACTS_READONLY_SCOPE,
  EMAIL_SCOPE,
  fetchVerifiedIdentity,
  OPENID_SCOPE,
  USERINFO_EMAIL_SCOPE,
} from './productivity.js';

/**
 * One Google login for Drive, Gmail, Calendar and Contacts (docs/GOOGLE_UNIFIED_SPEC.md).
 *
 * `perch google add` runs ONE loopback OAuth flow with the scopes of every selected service (the same scopes the
 * separate commands request; nothing new) and include_granted_scopes=true. Google's consent screen lets the user
 * untick single permissions, so the token response's `scope` decides what is connected: a service whose base
 * scope is missing is not connected, a missing write scope leaves the service read-only, and both are reported.
 *
 * The result is a Google account group (store section `googleGroups`, id ggroup-…) holding the OAuth client and
 * the refresh token once, plus the usual per-family records (google-… Drive, gmail-…, gprod-… Calendar/Contacts)
 * with `groupId` and no credentials of their own. Grants, tools and `perch client add --account` keep working on
 * the member ids unchanged. Re-adding the same Google account updates the group in place (same ids).
 */

export const GOOGLE_SERVICES = ['drive', 'gmail', 'calendar', 'contacts'] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];
export const GOOGLE_SERVICE_TITLES: Record<GoogleService, string> = { drive: 'Drive', gmail: 'Gmail', calendar: 'Calendar', contacts: 'Contacts' };

export function parseGoogleServices(list: string[]): GoogleService[] {
  const wanted = new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
  for (const s of wanted) {
    if (!(GOOGLE_SERVICES as readonly string[]).includes(s)) throw new PerchError(`Unknown service: ${s} (use drive, gmail, calendar, contacts)`, 'bad_argument');
  }
  const out = GOOGLE_SERVICES.filter((s) => wanted.has(s));
  if (!out.length) throw new PerchError('Select at least one service: --services drive,gmail,calendar,contacts', 'bad_argument');
  return out;
}

export interface GoogleGroupRequest {
  services: GoogleService[];
  /** Full Drive access (drive), as `--allow-write`. */
  driveWrite: boolean;
  gmail: { drafts: boolean; send: boolean; modify: boolean };
  /** calendar.events.owned, as `--allow-calendar-write`. */
  calendarWrite: boolean;
}

function serviceScopes(req: GoogleGroupRequest, s: GoogleService): string[] {
  switch (s) {
    // drive.readonly is requested next to drive so that unticking write on the consent screen still leaves read.
    case 'drive':
      return req.driveWrite ? [DRIVE_READONLY_SCOPE, DRIVE_SCOPE] : [DRIVE_READONLY_SCOPE];
    case 'gmail':
      return gmailScopesFor(req.gmail);
    case 'calendar':
      return req.calendarWrite ? [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE] : [CALENDAR_READONLY_SCOPE];
    case 'contacts':
      return [CONTACTS_READONLY_SCOPE];
  }
}

/** Every scope the flow requests: identity (openid email) plus the selected services' scopes. */
export function googleGroupScopes(req: GoogleGroupRequest): string[] {
  const services = parseGoogleServices(req.services);
  return [...new Set([OPENID_SCOPE, EMAIL_SCOPE, ...services.flatMap((s) => serviceScopes(req, s))])];
}

const BASE_GRANTED: Record<GoogleService, (g: ReadonlySet<string>) => boolean> = {
  drive: (g) => g.has(DRIVE_READONLY_SCOPE) || g.has(DRIVE_SCOPE),
  gmail: (g) => g.has(GMAIL_READONLY_SCOPE),
  calendar: (g) => g.has(CALENDAR_READONLY_SCOPE),
  contacts: (g) => g.has(CONTACTS_READONLY_SCOPE),
};

/** Requested write permissions: the scope, what it enables, and the add flag that requests it. */
const WRITE_SCOPES: Array<{ service: GoogleService; scope: string; what: string; flag: string; wanted: (r: GoogleGroupRequest) => boolean }> = [
  { service: 'drive', scope: DRIVE_SCOPE, what: 'Drive write (create, edit, share, trash)', flag: '--allow-write', wanted: (r) => r.driveWrite },
  { service: 'gmail', scope: GMAIL_COMPOSE_SCOPE, what: 'Gmail drafts and send', flag: '--allow-drafts', wanted: (r) => r.gmail.drafts },
  { service: 'gmail', scope: GMAIL_SEND_SCOPE, what: 'Gmail send', flag: '--allow-send', wanted: (r) => r.gmail.send && !r.gmail.drafts },
  { service: 'gmail', scope: GMAIL_MODIFY_SCOPE, what: 'Gmail organize (labels, archive, trash)', flag: '--allow-modify', wanted: (r) => r.gmail.modify },
  { service: 'calendar', scope: CALENDAR_EVENTS_OWNED_SCOPE, what: 'Calendar write (own events, invitations)', flag: '--allow-calendar-write', wanted: (r) => r.calendarWrite },
];

export interface GrantOutcome {
  /** Requested services whose base permission Google granted. */
  connected: GoogleService[];
  /** Requested services whose base permission was not granted (unticked on the consent screen). */
  denied: GoogleService[];
  /** Requested write permissions that were not granted; the service is connected read-only. */
  missingWrites: Array<{ service: GoogleService; what: string; flag: string }>;
}

/** Evaluates granular consent: what of the request the granted scopes (token response `scope`) cover. */
export function grantOutcome(req: GoogleGroupRequest, granted: readonly string[]): GrantOutcome {
  const g = new Set(granted);
  const services = parseGoogleServices(req.services);
  const connected = services.filter((s) => BASE_GRANTED[s](g));
  return {
    connected,
    denied: services.filter((s) => !connected.includes(s)),
    missingWrites: WRITE_SCOPES.filter((w) => connected.includes(w.service) && w.wanted(req) && !g.has(w.scope)).map(({ service, what, flag }) => ({ service, what, flag })),
  };
}

/**
 * Validates the authorization_code response: access token, offline refresh token and the identity scopes. Service
 * scopes are NOT required here (granular consent); grantOutcome decides per service.
 */
export function assertGroupGrant(tok: GoogleTokenResponse): AuthorizationResult {
  if (!tok.access_token) throw new PerchError('Google did not return an access token', 'oauth_incomplete');
  if (!tok.refresh_token) {
    throw new PerchError(
      'Google did not return a refresh token. Remove Perch under https://myaccount.google.com/permissions and retry.',
      'oauth_no_refresh_token',
    );
  }
  const scopes = (tok.scope ?? '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(OPENID_SCOPE) || !(scopes.includes(EMAIL_SCOPE) || scopes.includes(USERINFO_EMAIL_SCOPE))) {
    throw new PerchError('Google did not grant the account identity (openid email); retry and allow it on the consent screen.', 'oauth_scope_missing');
  }
  return { refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 0) * 1000, scopes };
}

export interface GoogleGroupAuthOptions {
  client: GoogleClientCredentials;
  upstream: Upstream;
  request: GoogleGroupRequest;
  port?: number;
  timeoutMs?: number;
  loginHint?: string;
  onAuthUrl: (url: string) => void;
}

/** One loopback flow (127.0.0.1, state, PKCE S256) for every selected service, include_granted_scopes=true. */
export function runGoogleGroupAuthorization(opts: GoogleGroupAuthOptions): Promise<AuthorizationResult> {
  return runLoopbackAuthorization({
    client: opts.client,
    upstream: opts.upstream,
    scopes: googleGroupScopes(opts.request),
    includeGrantedScopes: true,
    verify: assertGroupGrant,
    onAuthUrl: opts.onAuthUrl,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.loginHint ? { loginHint: opts.loginHint } : {}),
  });
}

const FAMILY_SCOPES: Record<GoogleMemberSection, readonly string[]> = {
  google: [DRIVE_READONLY_SCOPE, DRIVE_SCOPE],
  gmail: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE, GMAIL_MODIFY_SCOPE],
  googleProductivity: [CALENDAR_READONLY_SCOPE, CONTACTS_READONLY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE],
};
const IDENTITY_SCOPES = [OPENID_SCOPE, EMAIL_SCOPE, USERINFO_EMAIL_SCOPE];

/**
 * The scopes a member records: granted AND (requested now or recorded before) AND of its family. With
 * include_granted_scopes Google may report more than was asked for this time (earlier grants of the same OAuth
 * client); a member never takes over permissions the operator did not choose for it.
 */
function memberScopes(section: GoogleMemberSection, req: GoogleGroupRequest, granted: readonly string[], previous: readonly string[] = []): string[] {
  const requested = req.services
    .filter((s) => (section === 'google' ? s === 'drive' : section === 'gmail' ? s === 'gmail' : s === 'calendar' || s === 'contacts'))
    .flatMap((s) => serviceScopes(req, s));
  const wanted = new Set([...requested, ...previous]);
  const own = granted.filter((s) => FAMILY_SCOPES[section].includes(s) && wanted.has(s));
  return section === 'googleProductivity' ? [...granted.filter((s) => IDENTITY_SCOPES.includes(s)), ...own] : own;
}

export interface GroupRegistration {
  group: GoogleAccountGroup;
  /** True when an existing group (same Google account) was updated instead of creating one. */
  updated: boolean;
  /** Member account id per service after the update (Calendar and Contacts share one gprod-… record). */
  members: Partial<Record<GoogleService, string>>;
  /** Services connected by this run that were not connected before. */
  added: GoogleService[];
  outcome: GrantOutcome;
  /** Granted services that stay out of the group because the account is already connected separately. */
  separate: Array<{ service: GoogleService; id: string }>;
}

const sameAccount = (g: { sub: string; email: string }, id: { sub: string; email: string }) => g.sub === id.sub || g.email.toLowerCase() === id.email.toLowerCase();

/** The group of the Google account `email` (case-insensitive), if any. */
export function groupForEmail(data: StoreData, email: string): GoogleAccountGroup | undefined {
  return data.googleGroups.find((g) => g.email.toLowerCase() === email.toLowerCase());
}

/**
 * Stores a freshly authorised grant as a Google account group, or updates the existing group of the same Google
 * account (new refresh token and scopes, new services added, ids unchanged). `confirmUpdate` is asked before an
 * existing group is changed; false leaves the store untouched.
 */
export async function registerGoogleGroup(
  store: CredentialStore,
  upstream: Upstream,
  input: {
    label: string;
    client: GoogleClientCredentials;
    grant: AuthorizationResult;
    request: GoogleGroupRequest;
    confirmUpdate?: (group: GoogleAccountGroup, services: GoogleService[]) => Promise<boolean>;
  },
): Promise<GroupRegistration> {
  const label = validateLabel(input.label);
  const req: GoogleGroupRequest = { ...input.request, services: parseGoogleServices(input.request.services) };
  const identity = await fetchVerifiedIdentity(upstream, input.grant.accessToken);
  const outcome = grantOutcome(req, input.grant.scopes);
  const before = await store.read();
  const existing = before.googleGroups.find((g) => sameAccount(g, identity));
  if (existing && input.confirmUpdate) {
    if (!(await input.confirmUpdate(existing, groupServices(before, existing.id)))) {
      throw new PerchError(`Nothing changed: ${existing.id} (${existing.email}) was left as it is.`, 'aborted');
    }
  }
  if (!existing && !outcome.connected.length) {
    throw new PerchError(
      `Google granted none of the selected services (${req.services.map((s) => GOOGLE_SERVICE_TITLES[s]).join(', ')}); nothing was stored. ` +
        'Retry and tick the checkboxes of the services you want on the consent screen.',
      'oauth_scope_missing',
    );
  }
  return store.update((data) => {
    const now = new Date().toISOString();
    let group = data.googleGroups.find((g) => sameAccount(g, identity));
    if (existing && group?.id !== existing.id) {
      throw new PerchError(`Google account group ${existing.id} was removed or changed meanwhile; retry`, 'account_changed');
    }
    const updated = Boolean(group);
    const fields = {
      label,
      email: identity.email,
      sub: identity.sub,
      clientId: input.client.clientId,
      clientSecret: input.client.clientSecret,
      refreshToken: input.grant.refreshToken,
      scopes: input.grant.scopes,
      updatedAt: now,
    };
    if (group) Object.assign(group, fields);
    else group = { id: newAccountId('ggroup', data.googleGroups.map((g) => g.id)), ...fields, createdAt: now };
    const gid = group.id;
    const granted = input.grant.scopes;
    const has = (s: GoogleService) => outcome.connected.includes(s);
    const members: Partial<Record<GoogleService, string>> = {};
    const added: GoogleService[] = [];
    const separate: GroupRegistration['separate'] = [];
    const same = (email: string) => email.toLowerCase() === identity.email.toLowerCase();

    // Drive (google-…)
    const drive = data.google.find((a) => a.groupId === gid);
    if (drive) Object.assign(drive, { email: identity.email, scopes: memberScopes('google', req, granted, drive.scopes), updatedAt: now });
    else if (has('drive')) {
      const legacy = data.google.find((a) => !a.groupId && same(a.email));
      if (legacy) separate.push({ service: 'drive', id: legacy.id });
      else {
        const id = newAccountId('google', data.google.map((a) => a.id));
        data.google.push({ id, label, email: identity.email, groupId: gid, scopes: memberScopes('google', req, granted), createdAt: now, updatedAt: now });
        added.push('drive');
      }
    }
    const driveNow = data.google.find((a) => a.groupId === gid);
    if (driveNow) members.drive = driveNow.id;

    // Gmail (gmail-…)
    const gmail = data.gmail.find((a) => a.groupId === gid);
    if (gmail) Object.assign(gmail, { email: identity.email, scopes: memberScopes('gmail', req, granted, gmail.scopes), updatedAt: now });
    else if (has('gmail')) {
      const legacy = data.gmail.find((a) => !a.groupId && same(a.email));
      if (legacy) separate.push({ service: 'gmail', id: legacy.id });
      else {
        const id = newAccountId('gmail', data.gmail.map((a) => a.id));
        data.gmail.push({ id, label, email: identity.email, groupId: gid, scopes: memberScopes('gmail', req, granted), createdAt: now, updatedAt: now });
        added.push('gmail');
      }
    }
    const gmailNow = data.gmail.find((a) => a.groupId === gid);
    if (gmailNow) members.gmail = gmailNow.id;

    // Calendar and Contacts (one gprod-… record)
    const prodWanted = (['calendar', 'contacts'] as const).filter(has);
    const calendarWrite = req.calendarWrite && has('calendar') && granted.includes(CALENDAR_EVENTS_OWNED_SCOPE);
    const prod = data.googleProductivity.find((a) => a.groupId === gid);
    if (prod) {
      const services = (['calendar', 'contacts'] as const).filter((s) => prod.services.includes(s) || prodWanted.includes(s as never));
      added.push(...services.filter((s) => !prod.services.includes(s)));
      Object.assign(prod, {
        email: identity.email,
        sub: identity.sub,
        services,
        allowCalendarWrite: prod.allowCalendarWrite || calendarWrite,
        scopes: memberScopes('googleProductivity', req, granted, prod.scopes),
        updatedAt: now,
      });
    } else if (prodWanted.length) {
      const legacy = data.googleProductivity.find((a) => !a.groupId && (a.sub === identity.sub || same(a.email)));
      if (legacy) separate.push(...prodWanted.map((service) => ({ service, id: legacy.id })));
      else {
        const id = newAccountId('gprod', data.googleProductivity.map((a) => a.id));
        data.googleProductivity.push({
          id,
          label,
          email: identity.email,
          sub: identity.sub,
          groupId: gid,
          scopes: memberScopes('googleProductivity', req, granted),
          services: [...prodWanted],
          allowCalendarWrite: calendarWrite,
          createdAt: now,
          updatedAt: now,
        });
        added.push(...prodWanted);
      }
    }
    const prodNow = data.googleProductivity.find((a) => a.groupId === gid);
    for (const s of prodNow?.services ?? []) members[s] = prodNow!.id;

    if (!updated) {
      if (!Object.keys(members).length) {
        throw new PerchError(
          `Every granted service of ${identity.email} is already connected separately (${separate.map((s) => s.id).join(', ')}); nothing was stored. ` +
            'Remove those accounts first to connect them through one Google login.',
          'duplicate_account',
        );
      }
      data.googleGroups.push(group);
    }
    return { group: structuredClone(group), updated, members, added, outcome, separate };
  });
}

/**
 * `perch google remove`: without `service` the whole group (every member and the stored login; with `revoke` the
 * login is revoked at Google once first). With `service` only that service leaves the group; never revoked, because
 * the login is shared. A group whose last service is removed is removed with it.
 */
export async function removeGoogleGroup(
  store: CredentialStore,
  upstream: Upstream,
  id: string,
  opts: { revoke?: boolean; service?: GoogleService },
): Promise<{ group: GoogleAccountGroup; removed: string[]; groupRemoved: boolean; revoked: boolean }> {
  const data = await store.read();
  const group = findGroup(data, id);
  if (!group) throw new PerchError(`Unknown Google account group: ${id}`, 'unknown_account');
  if (opts.service) {
    if (opts.revoke) {
      throw new PerchError(
        `--revoke cannot be combined with --service: the login is shared, revoking it would disconnect every service of ${group.id}. ` +
          `Remove the service without --revoke, or the whole group with: perch google remove ${group.id} --revoke`,
        'bad_argument',
      );
    }
    const service = opts.service;
    return store.update((d) => {
      const m = groupMembers(d, group.id);
      const section: GoogleMemberSection = service === 'drive' ? 'google' : service === 'gmail' ? 'gmail' : 'googleProductivity';
      const member = service === 'drive' ? m.drive : service === 'gmail' ? m.gmail : m.productivity?.services.includes(service) ? m.productivity : undefined;
      if (!member) throw new PerchError(`${group.id} does not connect ${GOOGLE_SERVICE_TITLES[service]}`, 'unknown_account');
      const r = detachGroupMember(d, section, member.id, service === 'calendar' || service === 'contacts' ? service : undefined);
      return { group, removed: r.removedAccount ? [member.id] : [], groupRemoved: r.groupRemoved, revoked: false };
    });
  }
  let revoked = false;
  if (opts.revoke) {
    try {
      await revokeToken(upstream, group.refreshToken);
      revoked = true;
    } catch (err) {
      // A token that is already invalid cannot be revoked; removal still proceeds.
      if (!(err instanceof UpstreamError && err.status === 400)) throw err;
    }
  }
  return store.update((d) => {
    const m = groupMembers(d, group.id);
    const removed = [m.drive?.id, m.gmail?.id, m.productivity?.id].filter((x): x is string => Boolean(x));
    d.google = d.google.filter((a) => a.groupId !== group.id);
    d.gmail = d.gmail.filter((a) => a.groupId !== group.id);
    d.googleProductivity = d.googleProductivity.filter((a) => a.groupId !== group.id);
    d.googleGroups = d.googleGroups.filter((g) => g.id !== group.id);
    return { group, removed, groupRemoved: true, revoked };
  });
}
