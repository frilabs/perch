import { AuditLog } from './audit/audit.js';
import { GoogleTokenProvider } from './google/accounts.js';
import { CalendarService } from './google/calendar.js';
import { ContactsService } from './google/contacts.js';
import { DriveService } from './google/drive.js';
import { createProductivityTokenProvider } from './google/productivity.js';
import { createGmailTokenProvider } from './mail/gmailAccounts.js';
import { createMailProviders } from './mail/providers.js';
import { createMicrosoftTokenProvider } from './microsoft/accounts.js';
import type { RefreshingTokenProvider } from './oauth/tokenProvider.js';
import { MailService, type MailProviders } from './mail/service.js';
import { SendWorkflow } from './mail/workflow.js';
import { MailWorkflowLedger } from './mail/workflowLedger.js';
import { NotionService } from './notion/notion.js';
import { SlackService } from './slack/slack.js';
import type { CredentialStore, GmailAccount, GoogleProductivityAccount, MicrosoftAccount } from './store/credentialStore.js';
import { createFetchTransport, Upstream, type UpstreamTransport } from './upstream.js';
import { WhatsappService } from './whatsapp/whatsapp.js';

/** Long-lived services shared by all MCP requests (keeps the access-token caches warm). */
export interface PerchContext {
  store: CredentialStore;
  upstream: Upstream;
  drive: DriveService;
  notion: NotionService;
  mail: MailService;
  calendar: CalendarService;
  contacts: ContactsService;
  slack: SlackService;
  whatsapp: WhatsappService;
  /** The namespace's OAuth access-token providers (shared by services and status checks). */
  tokens: {
    drive: GoogleTokenProvider;
    gmail: RefreshingTokenProvider<GmailAccount>;
    microsoft: RefreshingTokenProvider<MicrosoftAccount>;
    productivity: RefreshingTokenProvider<GoogleProductivityAccount>;
  };
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
): PerchContext {
  const upstream = new Upstream(transport);
  const tokens = new GoogleTokenProvider(store, upstream);
  // One token provider for Calendar and Contacts: they share the account's single grant.
  const productivityTokens = createProductivityTokenProvider(store, upstream);
  // One ledger per namespace: idempotent sends and the audit trail share mail-workflow.enc.
  const ledger = new MailWorkflowLedger(store);
  const gmailTokens = createGmailTokenProvider(store, upstream);
  const microsoftTokens = createMicrosoftTokenProvider(store, upstream);
  const audit = new AuditLog(ledger);
  // Slack and WhatsApp sends use the same idempotent workflow (and send-record ledger) as mail.
  const workflow = new SendWorkflow(ledger);
  return {
    store,
    upstream,
    drive: new DriveService(store, upstream, tokens),
    notion: new NotionService(store, upstream),
    mail: new MailService(store, mailProviders ?? createMailProviders(store, upstream, { gmail: gmailTokens, microsoft: microsoftTokens }), ledger),
    calendar: new CalendarService(store, upstream, productivityTokens),
    contacts: new ContactsService(store, upstream, productivityTokens),
    slack: new SlackService(store, upstream, workflow, audit),
    whatsapp: new WhatsappService(store, upstream, workflow, audit),
    tokens: { drive: tokens, gmail: gmailTokens, microsoft: microsoftTokens, productivity: productivityTokens },
    audit,
  };
}
