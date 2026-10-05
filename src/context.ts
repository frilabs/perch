import { GoogleTokenProvider } from './google/accounts.js';
import { DriveService } from './google/drive.js';
import { NotionService } from './notion/notion.js';
import type { CredentialStore } from './store/credentialStore.js';
import { createFetchTransport, Upstream, type UpstreamTransport } from './upstream.js';

/** Long-lived services shared by all MCP requests (keeps the access-token cache warm). */
export interface PerchContext {
  store: CredentialStore;
  upstream: Upstream;
  drive: DriveService;
  notion: NotionService;
}

/** `transport` is only overridden by tests (mock upstreams); production uses fetch to fixed origins. */
export function createPerchContext(store: CredentialStore, transport: UpstreamTransport = createFetchTransport()): PerchContext {
  const upstream = new Upstream(transport);
  const tokens = new GoogleTokenProvider(store, upstream);
  return {
    store,
    upstream,
    drive: new DriveService(store, upstream, tokens),
    notion: new NotionService(store, upstream),
  };
}
