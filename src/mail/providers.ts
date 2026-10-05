import type { CredentialStore } from '../store/credentialStore.js';
import type { Upstream } from '../upstream.js';
import { createMicrosoftTokenProvider } from '../microsoft/accounts.js';
import { GmailProvider } from './gmail.js';
import { createGmailTokenProvider } from './gmailAccounts.js';
import { GraphMailProvider } from './graph.js';
import { ImapMailProvider } from './imap.js';
import type { MailProviders } from './service.js';

/** Production mail adapters: Gmail and Graph over the fixed-origin Upstream, IMAP/SMTP over TLS. */
export function createMailProviders(store: CredentialStore, upstream: Upstream): MailProviders {
  return {
    gmail: new GmailProvider(upstream, createGmailTokenProvider(store, upstream)),
    microsoft: new GraphMailProvider(upstream, createMicrosoftTokenProvider(store, upstream)),
    imap: new ImapMailProvider(),
  };
}
