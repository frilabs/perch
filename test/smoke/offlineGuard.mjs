// TEST-ONLY network guard for the smoke child processes. It is loaded with `node --import` (via
// NODE_OPTIONS in the smoke test env), so it runs before dist/cli.js and on every supported Node
// version (>=22.12). The production code and its fetch are untouched; nothing in src/ reads this.
//
// - globalThis.fetch is replaced: every call is recorded and rejected before any socket exists.
// - net.Socket#connect (used by http/https/tls/undici and the IMAP/SMTP clients) throws, so nothing
//   else can open an outbound TCP connection or trigger a DNS lookup either.
// Every blocked attempt is appended as one JSON line to PERCH_SMOKE_GUARD_LOG (if set), so the tests
// can prove the guard is active (probe) and that the real smoke run made zero attempts.
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const logFile = process.env.PERCH_SMOKE_GUARD_LOG;

function record(kind, target) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, kind, target: String(target) })}\n`);
}

function targetOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? '(unknown)';
}

globalThis.fetch = async function perchSmokeOfflineFetch(input) {
  const target = targetOf(input);
  record('fetch', target);
  throw new TypeError(`perch smoke offline guard: blocked fetch to ${target}`);
};

net.Socket.prototype.connect = function perchSmokeOfflineConnect(...args) {
  const o = args[0];
  const target = Array.isArray(o) ? JSON.stringify(o[0]) : typeof o === 'object' && o ? `${o.host ?? o.path ?? ''}:${o.port ?? ''}` : `${args[1] ?? ''}:${o}`;
  record('connect', target);
  throw new Error(`perch smoke offline guard: blocked socket connect to ${target}`);
};
