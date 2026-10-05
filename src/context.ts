import { GoogleTokenProvider } from './google/accounts.js';
import { DriveService } from './google/drive.js';
import { createMailProviders } from './mail/providers.js';
import { MailService, type MailProviders } from './mail/service.js';
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
  return {
    store,
    upstream,
    drive: new DriveService(store, upstream, tokens),
    notion: new NotionService(store, upstream),
    mail: new MailService(store, mailProviders ?? createMailProviders(store, upstream)),
  };
}
