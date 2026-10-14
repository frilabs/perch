import type { RefreshingTokenProvider } from '../oauth/tokenProvider.js';
import type { CredentialStore, GmailAccount, MicrosoftAccount } from '../store/credentialStore.js';
import type { Upstream } from '../upstream.js';
import { createMicrosoftTokenProvider } from '../microsoft/accounts.js';
import { GmailProvider } from './gmail.js';
import { createGmailTokenProvider } from './gmailAccounts.js';
import { GraphMailProvider } from './graph.js';
import { ImapMailProvider } from './imap.js';
import type { MailProviders } from './service.js';

/**
 * Production mail adapters: Gmail and Graph over the fixed-origin Upstream, IMAP/SMTP over TLS. `tokens`
 * shares the namespace's token providers (status checks reuse them, so refresh-token rotation never races).
 */
export function createMailProviders(
  store: CredentialStore,
  upstream: Upstream,
  tokens: { gmail: RefreshingTokenProvider<GmailAccount>; microsoft: RefreshingTokenProvider<MicrosoftAccount> } = {
    gmail: createGmailTokenProvider(store, upstream),
    microsoft: createMicrosoftTokenProvider(store, upstream),
  },
): MailProviders {
  return {
    gmail: new GmailProvider(upstream, tokens.gmail),
    microsoft: new GraphMailProvider(upstream, tokens.microsoft),
    imap: new ImapMailProvider(),
  };
}
