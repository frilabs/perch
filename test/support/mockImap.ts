/**
 * MOCK ImapSession for tests only: an in-memory fake of the narrow session interface the IMAP
 * provider uses. Nothing here talks to an IMAP server, and passing tests that use it are NOT
 * evidence of a live integration (the imapflow adapter is covered separately).
 */
import type { MessageEnvelopeObject, MessageStructureObject } from 'imapflow';
import type { ImapFetchedMessage, ImapMailboxLock, ImapSearchQuery, ImapSession } from '../../src/mail/imap.js';

export interface MockImapMessage {
  uid: number;
  envelope?: MessageEnvelopeObject;
  internalDate?: Date;
  bodyStructure?: MessageStructureObject;
  size?: number;
  /** Raw header lines returned for the requested header fields. */
  headers?: string;
  /** Decoded part content by body part number (what imapflow download() would stream). */
  parts?: Record<string, Buffer>;
}

export interface MockMailbox {
  uidValidity: string;
  messages: MockImapMessage[];
  specialUse?: string;
}

export class MockImapSession implements ImapSession {
  readonly calls: string[] = [];
  readonly opens: Array<{ mailbox: string; readOnly: true }> = [];
  readonly downloads: Array<{ uid: number; part: string; maxBytes: number }> = [];
  readonly appended: Array<{ mailbox: string; raw: Buffer; flags: string[] }> = [];
  released = 0;
  loggedOut = 0;
  private open: string | null = null;
  /** Fails the named operation with this error (to test cleanup on error). */
  failOn: { op: string; err: Error } | null = null;
  /** APPENDUID support (UIDPLUS); false simulates a server without it. */
  uidPlus = true;

  constructor(readonly mailboxes: Map<string, MockMailbox>) {}

  private step(op: string) {
    this.calls.push(op);
    if (this.failOn?.op === op) throw this.failOn.err;
  }

  private selected(): MockMailbox {
    // Every read operation must run while a read-only mailbox lock is held.
    if (!this.open) throw new Error('MOCK: no mailbox open');
    return this.mailboxes.get(this.open)!;
  }

  async openReadonly(mailbox: string): Promise<ImapMailboxLock> {
    this.step('open');
    const mb = this.mailboxes.get(mailbox);
    if (!mb) throw new Error(`MOCK: no mailbox ${mailbox}`);
    this.opens.push({ mailbox, readOnly: true });
    this.open = mailbox;
    return {
      uidValidity: mb.uidValidity,
      release: () => {
        this.released++;
        this.open = null;
      },
    };
  }

  async search(query: ImapSearchQuery): Promise<number[]> {
    this.step('search');
    const mb = this.selected();
    const hits = mb.messages.filter((m) => {
      if ('all' in query) return true;
      const hay = [m.envelope?.subject ?? '', ...Object.values(m.parts ?? {}).map((b) => b.toString('utf8'))].join('\n');
      return hay.toLowerCase().includes(query.text.toLowerCase());
    });
    // Servers return UIDs in ascending order; the provider has to sort.
    return hits.map((m) => m.uid).sort((a, b) => a - b);
  }

  async fetchSummaries(uids: number[]): Promise<ImapFetchedMessage[]> {
    this.step('fetchSummaries');
    const mb = this.selected();
    return mb.messages
      .filter((m) => uids.includes(m.uid))
      .sort((a, b) => a.uid - b.uid)
      .map((m) => ({
        uid: m.uid,
        ...(m.envelope ? { envelope: m.envelope } : {}),
        ...(m.internalDate ? { internalDate: m.internalDate } : {}),
        ...(m.bodyStructure ? { bodyStructure: m.bodyStructure } : {}),
      }));
  }

  async fetchMessage(uid: number): Promise<ImapFetchedMessage | undefined> {
    this.step('fetchMessage');
    const m = this.selected().messages.find((x) => x.uid === uid);
    if (!m) return undefined;
    return {
      uid: m.uid,
      ...(m.envelope ? { envelope: m.envelope } : {}),
      ...(m.internalDate ? { internalDate: m.internalDate } : {}),
      ...(m.bodyStructure ? { bodyStructure: m.bodyStructure } : {}),
      ...(m.size !== undefined ? { size: m.size } : {}),
      ...(m.headers !== undefined ? { headers: Buffer.from(m.headers) } : {}),
    };
  }

  async download(uid: number, part: string, maxBytes: number): Promise<Buffer | undefined> {
    this.step('download');
    this.downloads.push({ uid, part, maxBytes });
    const content = this.selected().messages.find((x) => x.uid === uid)?.parts?.[part];
    return content?.subarray(0, maxBytes);
  }

  async draftsMailbox(): Promise<string | undefined> {
    this.step('list');
    for (const [path, mb] of this.mailboxes) if (mb.specialUse === '\\Drafts') return path;
    return undefined;
  }

  async append(mailbox: string, raw: Buffer, flags: string[]): Promise<{ uid?: number; uidValidity?: string }> {
    this.step('append');
    const mb = this.mailboxes.get(mailbox);
    if (!mb) throw new Error(`MOCK: no mailbox ${mailbox}`);
    this.appended.push({ mailbox, raw, flags });
    const uid = Math.max(0, ...mb.messages.map((m) => m.uid)) + 1;
    mb.messages.push({ uid, parts: { '1': raw } });
    return this.uidPlus ? { uid, uidValidity: mb.uidValidity } : {};
  }

  async logout(): Promise<void> {
    this.loggedOut++;
  }
}

/** A plain-text message with an optional attachment, as a BODYSTRUCTURE tree. */
export function textMessage(
  uid: number,
  opts: { subject?: string; text?: string; html?: string; from?: string; date?: string; attachment?: { filename: string; content: Buffer; type?: string } } = {},
): MockImapMessage {
  const subject = opts.subject ?? `Dummy subject ${uid}`;
  const parts: Record<string, Buffer> = {};
  const leaves: MessageStructureObject[] = [];
  if (opts.text !== undefined) {
    leaves.push({ part: String(leaves.length + 1), type: 'text/plain', parameters: { charset: 'utf-8' }, encoding: '7bit', size: Buffer.byteLength(opts.text) });
    parts[String(leaves.length)] = Buffer.from(opts.text);
  }
  if (opts.html !== undefined) {
    leaves.push({ part: String(leaves.length + 1), type: 'text/html', parameters: { charset: 'utf-8' }, encoding: 'quoted-printable', size: Buffer.byteLength(opts.html) });
    parts[String(leaves.length)] = Buffer.from(opts.html);
  }
  if (opts.attachment) {
    const a = opts.attachment;
    leaves.push({
      part: String(leaves.length + 1),
      type: a.type ?? 'application/pdf',
      parameters: { name: a.filename },
      encoding: 'base64',
      size: Math.ceil(a.content.length / 3) * 4,
      disposition: 'attachment',
      dispositionParameters: { filename: a.filename },
    });
    parts[String(leaves.length)] = a.content;
  }
  // A single-part message's body is part "1" but carries no part number in BODYSTRUCTURE.
  const single = leaves.length === 1 && !opts.attachment;
  const bodyStructure: MessageStructureObject = single
    ? (({ part: _p, ...rest }) => rest)(leaves[0]!)
    : { type: 'multipart/mixed', childNodes: leaves };
  return {
    uid,
    envelope: {
      subject,
      date: new Date(opts.date ?? `2026-09-${String((uid % 28) + 1).padStart(2, '0')}T10:00:00Z`),
      from: [{ name: 'Dummy Sender', address: opts.from ?? 'dummy.sender@example.test' }],
      to: [{ address: 'dummy.me@gmx.at' }],
      messageId: `<dummy-${uid}@example.test>`,
    },
    internalDate: new Date('2026-09-30T10:00:00Z'),
    bodyStructure,
    size: 1000,
    headers: `Message-ID: <dummy-${uid}@example.test>\r\nIn-Reply-To: <parent-${uid}@example.test>\r\nReferences: <root@example.test>\r\n <parent-${uid}@example.test>\r\n\r\n`,
    parts,
  };
}
