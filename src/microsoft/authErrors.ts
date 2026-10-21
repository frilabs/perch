import { PerchError } from '../errors.js';
import { OAuthDeniedError } from '../oauth/loopback.js';
import { UpstreamError } from '../upstream.js';
import { shortClientId } from './clientSetup.js';
import { FRILABS_MICROSOFT_APP_NAME } from './defaultApp.js';
import { microsoftScopesFor, validateTenant } from './oauth.js';

/**
 * Microsoft sign-in errors in plain words, plus the admin consent link for organisations that block user
 * consent (docs/MICROSOFT_FRILABS_APP_SPEC.md). Messages carry at most the OAuth error name and the AADSTS
 * number; never codes, tokens or Microsoft's error description.
 */

export type MicrosoftAuthProblem = 'admin_consent' | 'wrong_tenant' | 'unknown_app' | 'redirect_mismatch' | 'conditional_access';

const ADMIN_CONSENT_CODES = new Set(['65001', '90094', '90095']);
const PROBLEM_BY_CODE: Record<string, MicrosoftAuthProblem> = {
  '50020': 'wrong_tenant',
  '700016': 'unknown_app',
  '50011': 'redirect_mismatch',
  '53003': 'conditional_access',
};

export function classifyMicrosoftAuthError(e: { error?: string; aadsts?: string; mentionsAdminApproval?: boolean }): MicrosoftAuthProblem | undefined {
  if (e.aadsts && ADMIN_CONSENT_CODES.has(e.aadsts)) return 'admin_consent';
  if (e.aadsts && PROBLEM_BY_CODE[e.aadsts]) return PROBLEM_BY_CODE[e.aadsts];
  if (e.error === 'consent_required' || e.error === 'admin_consent_required' || e.mentionsAdminApproval) return 'admin_consent';
  return undefined;
}

/** Every Graph permission Perch may use, so one admin approval covers read and the write opt-ins. */
export function adminConsentScopes(): string[] {
  return microsoftScopesFor({ drafts: true, send: true }).map((s) => (s === 'offline_access' ? s : `https://graph.microsoft.com/${s}`));
}

/**
 * Tenant for the admin consent link: `organizations` (default; the admin signs in to their own organisation),
 * a tenant GUID or a domain. An e-mail address is reduced to its domain. common/consumers make no sense here.
 */
export function adminConsentTenant(raw?: string): string {
  if (raw === undefined) return 'organizations';
  let t = raw.trim();
  if (t.includes('@')) t = t.slice(t.lastIndexOf('@') + 1);
  t = t.toLowerCase();
  const bad = () =>
    new PerchError('--tenant must be a domain (e.g. example.com) or a tenant ID (GUID)', 'usage');
  if (t === 'common' || t === 'consumers') throw bad();
  try {
    return validateTenant(t);
  } catch {
    throw bad();
  }
}

/** https://login.microsoftonline.com/<tenant>/v2.0/adminconsent?client_id=…&scope=…&redirect_uri=http://localhost */
export function adminConsentUrl(clientId: string, tenant = 'organizations'): string {
  const q = [
    ['client_id', clientId],
    ['scope', adminConsentScopes().join(' ')],
    ['redirect_uri', 'http://localhost'],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join('&');
  return `https://login.microsoftonline.com/${encodeURIComponent(validateTenant(tenant))}/v2.0/adminconsent?${q}`;
}

export interface MicrosoftAppInfo {
  clientId: string;
  /** The built-in frilabs app (named "Perch (frilabs)") rather than the operator's own registration. */
  frilabs: boolean;
}

/** The link plus a short text the user can forward to their IT administrator (lines ≤ 80 columns except the URL). */
export function adminConsentBlock(app: MicrosoftAppInfo, tenant = 'organizations'): string {
  const url = adminConsentUrl(app.clientId, tenant);
  const name = app.frilabs ? `"${FRILABS_MICROSOFT_APP_NAME}"` : '"Perch"';
  return (
    'Admin consent link (an administrator of the organisation opens it, signs in\n' +
    'and approves; afterwards the browser shows "This site can\'t be reached" on\n' +
    'localhost, which is expected):\n\n' +
    `  ${url}\n\n` +
    'Text to forward to your IT administrator:\n\n' +
    `  Please approve the Microsoft app ${name} for our organisation\n` +
    `  (client ID ${app.clientId}).\n` +
    '  Perch is a self-hosted connector: it runs on my own computer or server\n' +
    '  and lets my AI assistants work with my own Outlook mailbox. It asks for\n' +
    '  the delegated Microsoft Graph permissions User.Read, Mail.Read,\n' +
    '  Mail.ReadWrite and Mail.Send plus offline_access, always only for the\n' +
    '  signed-in user. Writing or sending needs my explicit opt-in in Perch.\n' +
    (app.frilabs
      ? '  Sign-in tokens and mail stay on my machine; frilabs, the publisher,\n' +
        '  never receives any mail or account data.\n'
      : '  Sign-in tokens and mail stay on my machine; no third party receives\n' +
        '  any mail or account data.\n') +
    '  Approval link:\n' +
    `  ${url}\n`
  );
}

export class MicrosoftAuthError extends PerchError {
  constructor(
    message: string,
    readonly problem: MicrosoftAuthProblem,
  ) {
    super(message, `microsoft_${problem}`);
  }
}

function describe(problem: MicrosoftAuthProblem, ref: string, ctx: { app: MicrosoftAppInfo; tenant: string }): string {
  switch (problem) {
    case 'admin_consent': {
      // `common`/`consumers` cannot host an admin consent; the admin's own organisation is found at sign-in.
      const tenant = ['common', 'consumers', 'organizations'].includes(ctx.tenant) ? 'organizations' : ctx.tenant;
      return (
        `Your organisation requires an admin to approve Perch first (${ref}).\n` +
        'Send the link below to your IT administrator; once approved, run\n' +
        'perch microsoft add again. For a link for one specific organisation:\n' +
        'perch microsoft admin-consent-link --tenant yourcompany.com\n\n' +
        adminConsentBlock(ctx.app, tenant)
      );
    }
    case 'wrong_tenant':
      if (ctx.tenant === 'common') {
        return (
          `Microsoft rejected this account for the tenant "common" (${ref}).\n` +
          'Sign in with a different account, or set PERCH_MICROSOFT_TENANT to your\n' +
          "organisation's domain in .env and run perch microsoft add again."
        );
      }
      return (
        `This account does not belong to the Microsoft tenant "${ctx.tenant}"\n` +
        `(${ref}). Sign in with an account of that organisation, or set\n` +
        'PERCH_MICROSOFT_TENANT=common in .env and run perch microsoft add again.'
      );
    case 'unknown_app':
      return (
        `Microsoft does not know the app with client ID ${shortClientId(ctx.app.clientId)} (${ref}).\n` +
        (ctx.app.frilabs
          ? `The built-in ${FRILABS_MICROSOFT_APP_NAME} app is not available. Use your own app\n` +
            'registration instead: perch microsoft client setup'
          : 'The client ID is wrong or the app registration was deleted. Check it with\n' +
            'perch microsoft client show and replace it with perch microsoft client setup.')
      );
    case 'redirect_mismatch':
      return (
        `The redirect address does not match the app registration (${ref}).\n` +
        'In the Entra admin center, the app needs the platform "Mobile and desktop\n' +
        'applications" with the redirect URI http://localhost (Authentication page).'
      );
    case 'conditional_access':
      return (
        `Your organisation's access policy (Conditional Access) blocks this\n` +
        `sign-in (${ref}). Only an administrator of your organisation can allow it.`
      );
  }
}

/**
 * Maps a failed Microsoft authorization (callback `error=` or token endpoint error) to a clear message;
 * anything unrecognised is returned unchanged.
 */
export function explainMicrosoftAuthError(err: unknown, ctx: { app: MicrosoftAppInfo; tenant: string }): unknown {
  let facts: { error?: string; aadsts?: string; mentionsAdminApproval?: boolean } | undefined;
  if (err instanceof OAuthDeniedError) {
    facts = { error: err.providerError, ...(err.aadstsCode ? { aadsts: err.aadstsCode } : {}), mentionsAdminApproval: err.mentionsAdminApproval };
  } else if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) {
    facts = { ...(err.upstreamCode ? { error: err.upstreamCode } : {}), ...(err.aadstsCode ? { aadsts: err.aadstsCode } : {}) };
  }
  if (!facts) return err;
  const problem = classifyMicrosoftAuthError(facts);
  if (!problem) return err;
  const ref = facts.aadsts ? `AADSTS${facts.aadsts}` : (facts.error ?? 'error');
  return new MicrosoftAuthError(describe(problem, ref, ctx), problem);
}
