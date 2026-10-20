import addressparser from 'nodemailer/lib/addressparser';
import { PerchError } from '../errors.js';
import { isAddress, MAX_RECIPIENTS } from './compose.js';

/**
 * Turns a stored IMAP draft (complete RFC 5322 message, Bcc header included, as Perch and mail clients store
 * them) into what SMTP submission needs: the envelope recipients from To/Cc/Bcc, and a copy WITHOUT the Bcc
 * header (Bcc recipients must never be visible to the other recipients). The message is otherwise transmitted
 * byte for byte. The sender is always the account address: a draft whose From names another address is refused.
 */

const bad = (msg: string) => new PerchError(msg, 'bad_argument');
/** Header fields removed from the transmitted copy (envelope-only information). */
const STRIPPED = new Set(['bcc', 'resent-bcc']);

interface HeaderField {
  name: string;
  /** Raw field text including its line breaks (for removal by range). */
  start: number;
  end: number;
  /** Unfolded value. */
  value: string;
}

/** Splits the header block (latin1, so byte offsets are kept) into fields; returns the header end offset. */
function headerFields(text: string): { fields: HeaderField[]; headerEnd: number } {
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');
  let headerEnd: number;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) headerEnd = crlf + 2;
  else if (lf >= 0) headerEnd = lf + 1;
  else throw bad('The draft has no header/body separator');
  const fields: HeaderField[] = [];
  let pos = 0;
  while (pos < headerEnd) {
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd < 0 || lineEnd >= headerEnd) lineEnd = headerEnd - 1;
    const line = text.slice(pos, lineEnd + 1);
    if ((line.startsWith(' ') || line.startsWith('\t')) && fields.length) {
      const f = fields[fields.length - 1]!;
      f.end = lineEnd + 1;
      f.value += ` ${line.trim()}`;
    } else {
      const colon = line.indexOf(':');
      if (colon <= 0) throw bad('The draft has a malformed header');
      fields.push({ name: line.slice(0, colon).trim().toLowerCase(), start: pos, end: lineEnd + 1, value: line.slice(colon + 1).trim() });
    }
    pos = lineEnd + 1;
  }
  return { fields, headerEnd };
}

function addresses(field: string, values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const a of addressparser(v, { flatten: true })) {
      if (!a.address) continue;
      if (!isAddress(a.address)) throw bad(`The draft has an invalid ${field} address`);
      out.push(a.address);
    }
  }
  return out;
}

export interface SmtpReadyDraft {
  raw: Buffer;
  envelope: { from: string; to: string[] };
}

export function prepareDraftForSmtp(raw: Buffer, accountEmail: string): SmtpReadyDraft {
  const text = raw.toString('latin1');
  const { fields } = headerFields(text);
  const values = (name: string) => fields.filter((f) => f.name === name).map((f) => f.value);

  const from = addresses('From', values('from'));
  if (from.length !== 1 || from[0]!.toLowerCase() !== accountEmail.toLowerCase()) {
    throw bad('The draft must have exactly one From address, the address of the chosen account');
  }
  const seen = new Map<string, string>();
  for (const a of addresses('recipient', [...values('to'), ...values('cc'), ...values('bcc')])) {
    if (!seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  }
  const to = [...seen.values()];
  if (!to.length) throw bad('The draft has no recipients (To, Cc or Bcc)');
  if (to.length > MAX_RECIPIENTS) throw bad(`The draft has more than ${MAX_RECIPIENTS} recipients`);

  // Remove Bcc fields (with their continuation lines) from the transmitted copy; everything else is untouched.
  let stripped = '';
  let pos = 0;
  for (const f of fields) {
    if (!STRIPPED.has(f.name)) continue;
    stripped += text.slice(pos, f.start);
    pos = f.end;
  }
  stripped += text.slice(pos);
  return { raw: Buffer.from(stripped, 'latin1'), envelope: { from: accountEmail, to } };
}
