import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PerchError } from '../errors.js';
import { base32Encode } from './base32.js';
import type { DcrRegistration, ResolvedClient } from './clients.js';
import type { GoogleIdentity } from './google.js';

/**
 * Pairing windows (Spec §0a, §6). Held in memory by the running server only: a window exists only while
 * the operator's `perch oauth pair` (or the local /local/pair page) holds it open, for at most 10 minutes,
 * and it pairs at most one device. Every session belongs to exactly one window.
 */
export const PAIR_WINDOW_MS = 10 * 60 * 1000;
export const PAIR_CODE_MAX_FAILURES = 3;
export const MAX_DCR_PER_WINDOW = 3;
export const AUTH_CODE_TTL_MS = 60 * 1000;
export const FIRST_USE_WAIT_MS = 5 * 60 * 1000;
const MAX_SESSIONS_PER_WINDOW = 10;

export type PairStep = 'code' | 'google' | 'totp' | 'confirm' | 'approved' | 'done';

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource: string;
}

export interface PairSession {
  id: string;
  csrf: string;
  createdAt: number;
  auth: AuthRequest;
  client: ResolvedClient;
  step: PairStep;
  google?: { state: string; nonce: string; verifier: string };
  identity?: GoogleIdentity;
  usedRecoveryCode?: boolean;
  userAgent?: string;
  ip?: string;
  deviceId?: string;
  authCode?: string;
}

export interface ConfirmDetails {
  clientName: string;
  clientDisplay: string;
  registration: string;
  redirectHost: string;
  googleEmail: string;
  userAgent: string;
  ip: string;
  secondsSinceOpen: number;
  usedRecoveryCode: boolean;
}

export type PairEvent =
  | { type: 'opened'; windowId: string; code: string; expiresAt: string }
  | { type: 'progress'; step: 'started' | 'code_ok' | 'google_ok' | 'totp_ok' }
  | { type: 'confirm'; confirmId: string; details: ConfirmDetails }
  | { type: 'paired'; deviceId: string }
  | { type: 'first_use'; deviceId: string }
  | { type: 'alarm'; kind: 'second_pairing_attempt' | 'pairing_code_wrong' | 'pairing_locked' }
  | { type: 'closed'; reason: CloseReason };

export type CloseReason = 'expired' | 'aborted' | 'rejected' | 'consumed' | 'second_attempt' | 'code_failures' | 'totp_lockout' | 'kill_switch' | 'replaced';

export type PairListener = (ev: PairEvent) => void;

interface PairWindow {
  id: string;
  code: string;
  openedAt: number;
  expiresAt: number;
  codeFailures: number;
  sessions: Map<string, PairSession>;
  /** Session that passed the pairing code (at most one per window). */
  codeSession?: string;
  dcr: Map<string, DcrRegistration>;
  confirming?: { sessionId: string; confirmId: string; onAnswer: (approved: boolean) => void };
  /** A device was already issued in this window (one device per window). */
  issued: boolean;
  listener: PairListener;
  timer: NodeJS.Timeout;
}

export interface IssuedCode {
  deviceId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
}

const random = (bytes: number) => randomBytes(bytes).toString('base64url');

/** 8 base32 characters = 40 bits (Spec §0a item 2). */
export const newPairingCode = () => base32Encode(randomBytes(5), { pad: false });

export class PairingManager {
  private window: PairWindow | null = null;
  private readonly codes = new Map<string, IssuedCode>();
  /** Exchanged codes (10 min): a second use ends the device (RFC 6749 §4.1.2). */
  private readonly usedCodes = new Map<string, { deviceId: string; until: number }>();
  /** After a pairing: who waits for the first /mcp call of which device (Gegenprobe). */
  private readonly firstUseWatch = new Map<string, { listener: PairListener; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get isOpen(): boolean {
    this.expireIfDue();
    return this.window !== null;
  }

  /** Opens the (single) window. A second open while one is open is refused. */
  open(listener: PairListener): { windowId: string; code: string; expiresAt: number } {
    this.expireIfDue();
    if (this.window) throw new PerchError('A pairing window is already open (only one at a time)', 'pairing_busy');
    const openedAt = this.now();
    const w: PairWindow = {
      id: random(9),
      code: newPairingCode(),
      openedAt,
      expiresAt: openedAt + PAIR_WINDOW_MS,
      codeFailures: 0,
      sessions: new Map(),
      dcr: new Map(),
      issued: false,
      listener,
      timer: setTimeout(() => this.close('expired'), PAIR_WINDOW_MS),
    };
    w.timer.unref?.();
    this.window = w;
    listener({ type: 'opened', windowId: w.id, code: w.code, expiresAt: new Date(w.expiresAt).toISOString() });
    return { windowId: w.id, code: w.code, expiresAt: w.expiresAt };
  }

  /** Closes the window (if any, optionally only if it is `windowId`) and discards its sessions. */
  close(reason: CloseReason, windowId?: string): void {
    const w = this.window;
    if (!w || (windowId !== undefined && w.id !== windowId)) return;
    clearTimeout(w.timer);
    this.window = null;
    w.confirming?.onAnswer(false);
    w.listener({ type: 'closed', reason });
  }

  private expireIfDue(): void {
    if (this.window && this.now() >= this.window.expiresAt) this.close('expired');
  }

  private emit(ev: PairEvent): void {
    this.window?.listener(ev);
  }

  /** DCR registrations of the open window (empty map without a window). */
  dcrRegistrations(): ReadonlyMap<string, DcrRegistration> {
    this.expireIfDue();
    return this.window?.dcr ?? new Map();
  }

  addDcr(reg: DcrRegistration): void {
    this.expireIfDue();
    const w = this.window;
    if (!w) throw new PerchError('No pairing window is open', 'no_pairing_window');
    if (w.dcr.size >= MAX_DCR_PER_WINDOW) throw new PerchError('Too many registrations in this pairing window', 'too_many_registrations');
    w.dcr.set(reg.clientId, reg);
  }

  /**
   * Starts (or restarts, for the same browser) a session for an authorization request. A different
   * browser session while another one already passed the pairing code closes the window (Spec §6 step 3).
   */
  startSession(existingId: string | undefined, input: { auth: AuthRequest; client: ResolvedClient; userAgent?: string; ip?: string }): PairSession {
    this.expireIfDue();
    const w = this.window;
    if (!w) throw new PerchError('No pairing window is open', 'no_pairing_window');
    const same = existingId !== undefined ? w.sessions.get(existingId) : undefined;
    if (!same && w.codeSession !== undefined) {
      this.alarmSecondAttempt();
      throw new PerchError('A second sign-in attempt in this pairing window; the window was closed', 'second_pairing_attempt');
    }
    if (same && w.codeSession === same.id) {
      // The browser that passed the pairing code started over: never reset its progress (that would let
      // another browser join without an alarm). The window is closed; the operator opens a new one.
      this.close('replaced');
      throw new PerchError('This sign-in was started again after the pairing code; the window was closed. Open a new one.', 'pairing_restarted');
    }
    if (!same && w.sessions.size >= MAX_SESSIONS_PER_WINDOW) throw new PerchError('Too many sign-in attempts in this pairing window', 'too_many_sessions');
    const session: PairSession = {
      id: same?.id ?? random(24),
      csrf: random(24),
      createdAt: this.now(),
      auth: input.auth,
      client: input.client,
      step: 'code',
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(input.ip ? { ip: input.ip } : {}),
    };
    w.sessions.set(session.id, session);
    this.emit({ type: 'progress', step: 'started' });
    return session;
  }

  /** Session of the open window, or null (unknown, other window, or no window). */
  session(id: string | undefined): PairSession | null {
    this.expireIfDue();
    if (!id || !this.window) return null;
    return this.window.sessions.get(id) ?? null;
  }

  private alarmSecondAttempt(): void {
    this.emit({ type: 'alarm', kind: 'second_pairing_attempt' });
    this.close('second_attempt');
  }

  /** Step 4: pairing code. Wrong codes count per window; the third closes it. */
  submitPairingCode(s: PairSession, code: string): boolean {
    const w = this.window;
    if (!w || !w.sessions.has(s.id) || s.step !== 'code') throw new PerchError('This sign-in is no longer valid', 'pairing_session_invalid');
    const given = Buffer.from(code.replace(/[\s-]/g, '').toUpperCase());
    const expected = Buffer.from(w.code);
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      w.codeFailures++;
      this.emit({ type: 'alarm', kind: 'pairing_code_wrong' });
      if (w.codeFailures >= PAIR_CODE_MAX_FAILURES) this.close('code_failures');
      return false;
    }
    if (w.codeSession !== undefined && w.codeSession !== s.id) {
      this.alarmSecondAttempt();
      throw new PerchError('A second sign-in attempt in this pairing window; the window was closed', 'second_pairing_attempt');
    }
    w.codeSession = s.id;
    s.step = 'google';
    this.emit({ type: 'progress', step: 'code_ok' });
    return true;
  }

  googleStarted(s: PairSession, google: NonNullable<PairSession['google']>): void {
    this.assertCurrent(s, 'google');
    s.google = google;
  }

  googleDone(s: PairSession, identity: GoogleIdentity): void {
    this.assertCurrent(s, 'google');
    s.identity = identity;
    s.google = undefined;
    s.step = 'totp';
    this.emit({ type: 'progress', step: 'google_ok' });
  }

  /**
   * Step 6 passed: asks the operator for the final confirmation (Spec §6 step 7). `onApproved` creates the
   * device (and returns its id); the authorization code is issued only after it resolves.
   */
  totpDone(s: PairSession, usedRecoveryCode: boolean, onApproved: (s: PairSession) => Promise<string>, onAbandoned: (deviceId: string) => void = () => {}): void {
    this.assertCurrent(s, 'totp');
    const w = this.window!;
    if (w.confirming || w.issued) {
      this.alarmSecondAttempt();
      throw new PerchError('A second sign-in attempt in this pairing window; the window was closed', 'second_pairing_attempt');
    }
    s.usedRecoveryCode = usedRecoveryCode;
    s.step = 'confirm';
    this.emit({ type: 'progress', step: 'totp_ok' });
    const details: ConfirmDetails = {
      clientName: s.client.clientName,
      clientDisplay: s.client.displayName,
      registration: s.client.registration === 'cimd' ? `metadata document ${s.client.clientId}` : s.client.registration === 'dcr' ? 'self-registered (DCR)' : 'pre-registered',
      redirectHost: redirectHostOf(s.auth.redirectUri),
      googleEmail: s.identity!.email,
      userAgent: s.userAgent ?? 'unknown',
      ip: s.ip ?? 'unknown',
      secondsSinceOpen: Math.round((this.now() - w.openedAt) / 1000),
      usedRecoveryCode,
    };
    const confirmId = random(12);
    w.confirming = {
      sessionId: s.id,
      confirmId,
      onAnswer: (approved) => {
        w.confirming = undefined;
        if (!approved) {
          if (this.window === w) this.close('rejected');
          return;
        }
        w.issued = true;
        void onApproved(s).then(
          (deviceId) => {
            if (this.window !== w) {
              onAbandoned(deviceId); // the window closed meanwhile: the device must not stay active
              return;
            }
            s.deviceId = deviceId;
            s.authCode = random(32);
            this.codes.set(s.authCode, {
              deviceId,
              clientId: s.auth.clientId,
              redirectUri: s.auth.redirectUri,
              codeChallenge: s.auth.codeChallenge,
              resource: s.auth.resource,
              expiresAt: this.now() + AUTH_CODE_TTL_MS,
            });
            s.step = 'approved';
            for (const [id, fw] of this.firstUseWatch) if (fw.until <= this.now()) this.firstUseWatch.delete(id);
            this.firstUseWatch.set(deviceId, { listener: w.listener, until: this.now() + FIRST_USE_WAIT_MS });
            this.emit({ type: 'paired', deviceId });
          },
          () => {
            if (this.window === w) this.close('aborted');
          },
        );
      },
    };
    this.emit({ type: 'confirm', confirmId, details });
  }

  /** The operator's answer (control channel or local page) for the open window. */
  /**
   * The operator's answer for exactly the confirmation they were shown (window id and confirmation id
   * from the 'confirm' event). A stale or foreign answer is refused.
   */
  answer(approved: boolean, windowId: string, confirmId: string): void {
    const w = this.window;
    if (!w || w.id !== windowId || !w.confirming || w.confirming.confirmId !== confirmId) throw new PerchError('Nothing is waiting for this confirmation', 'nothing_to_confirm');
    w.confirming.onAnswer(approved);
  }

  /** The browser picked up its redirect: the window is consumed. */
  finish(s: PairSession): void {
    if (s.step !== 'approved') return;
    s.step = 'done';
    if (this.window?.sessions.has(s.id)) this.close('consumed');
  }

  /** Single-use authorization code (Spec §6 step 8). */
  takeCode(code: string): IssuedCode | { reused: string } | null {
    const t = this.now();
    for (const [k, v] of this.usedCodes) if (v.until <= t) this.usedCodes.delete(k);
    const used = this.usedCodes.get(code);
    if (used) return { reused: used.deviceId };
    const c = this.codes.get(code);
    if (!c) return null;
    this.codes.delete(code);
    this.usedCodes.set(code, { deviceId: c.deviceId, until: t + 10 * 60 * 1000 });
    return c.expiresAt > t ? c : null;
  }

  /** TOTP lockout or kill switch: close without pairing. */
  lockout(reason: 'totp_lockout' | 'kill_switch'): void {
    if (reason === 'totp_lockout') this.emit({ type: 'alarm', kind: 'pairing_locked' });
    this.close(reason);
  }

  /** First /mcp call of a freshly paired device (Gegenprobe, Spec §0a item 6). */
  firstUse(deviceId: string): void {
    const w = this.firstUseWatch.get(deviceId);
    if (!w) return;
    this.firstUseWatch.delete(deviceId);
    if (w.until > this.now()) w.listener({ type: 'first_use', deviceId });
  }

  stopWatching(listener: PairListener): void {
    for (const [id, w] of this.firstUseWatch) if (w.listener === listener) this.firstUseWatch.delete(id);
  }

  private assertCurrent(s: PairSession, step: PairStep): void {
    this.expireIfDue();
    if (!this.window || !this.window.sessions.has(s.id) || s.step !== step || this.window.codeSession !== s.id) {
      throw new PerchError('This sign-in is no longer valid', 'pairing_session_invalid');
    }
  }

  /** Id of the open window, if any. */
  get windowId(): string | undefined {
    this.expireIfDue();
    return this.window?.id;
  }

  /** For status output. */
  openSince(): number | null {
    this.expireIfDue();
    return this.window?.openedAt ?? null;
  }
}

function redirectHostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '?';
  }
}
