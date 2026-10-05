import { AuditLog } from './audit/audit.js';
import { GoogleTokenProvider } from './google/accounts.js';
import { CalendarService } from './google/calendar.js';
import { ContactsService } from './google/contacts.js';
import { DriveService } from './google/drive.js';
import { createProductivityTokenProvider } from './google/productivity.js';
import { createMailProviders } from './mail/providers.js';
import { MailService, type MailProviders } from './mail/service.js';
import { MailWorkflowLedger } from './mail/workflowLedger.js';
import { NotionService } from './notion/notion.js';
import type { CredentialStore } from './store/credentialStore.js';
import { createFetchTransport, Upstream, type UpstreamTransport } from './upstream.js';

/** Long-lived services shared by all MCP requests (keeps the access-token caches warm). */
export interface PerchContext {
  store: CredentialStore;
  upstream: Upstream;
  drive: DriveService;
  notion: NotionService;
  mail: MailService;
  calendar: CalendarService;
  contacts: ContactsService;
  /** Body-free audit trail of this namespace (in its mail workflow ledger), written by the MCP tool runner. */
  audit: AuditLog;
}

/**
 * `transport` and `mailProviders` are only overridden by tests (MOCK upstreams/providers);
 * production uses fetch to fixed origins and the real mail adapters.
 */
export function createPerchContext(
  store: CredentialStore,
  transport: UpstreamTransport = createFetchTransport(),
  mailProviders?: MailProviders,
  /** Namespace guard of a user namespace (NamespaceRouter); MailService runs it on every call. */
  guard?: () => Promise<void>,
): PerchContext {
  const upstream = new Upstream(transport);
  const tokens = new GoogleTokenProvider(store, upstream);
  // One token provider for Calendar and Contacts: they share the account's single grant.
  const productivityTokens = createProductivityTokenProvider(store, upstream);
  // One ledger per namespace: idempotent sends and the audit trail share mail-workflow.enc.
  const ledger = new MailWorkflowLedger(store);
  return {
    store,
    upstream,
    drive: new DriveService(store, upstream, tokens),
    notion: new NotionService(store, upstream),
    mail: new MailService(store, mailProviders ?? createMailProviders(store, upstream), ledger, guard ? { guard } : {}),
    calendar: new CalendarService(store, upstream, productivityTokens),
    contacts: new ContactsService(store, upstream, productivityTokens),
    audit: new AuditLog(ledger),
  };
}
