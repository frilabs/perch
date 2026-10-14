import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { PerchError } from '../errors.js';
import { assertPrivateDir } from '../secureFs.js';
import type { PairEvent, PairingManager, PairListener } from './pairing.js';

/**
 * Local control channel between `perch oauth pair` and the running server (Spec §6): a Unix socket in the
 * data directory (0700), created with mode 0600. Newline-delimited JSON. Only the owner of the data
 * directory can connect; the client refuses a socket that is a symlink, not a socket, owned by someone
 * else or accessible by group/others. Closing the connection closes the window.
 */
export const CONTROL_SOCKET = 'control.sock';
const MAX_LINE = 4096;

export const controlSocketPath = (dataDir: string) => path.join(dataDir, CONTROL_SOCKET);

type ClientMessage = { op: 'open' } | { op: 'answer'; approved: boolean };

function lines(socket: Socket, onLine: (line: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE * 4) {
      socket.destroy();
      return;
    }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.length <= MAX_LINE) onLine(line);
    }
  });
}

const send = (socket: Socket, msg: unknown) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
};

export interface ControlServer {
  close(): Promise<void>;
}

/**
 * Starts the control socket. `canOpen` runs before a window opens (TOTP set up, login allowlist, kill
 * switch, lockout) and throws a PerchError with the reason.
 */
export async function startControlServer(
  dataDir: string,
  manager: PairingManager,
  hooks: { canOpen: () => Promise<void>; onEvent?: (ev: PairEvent) => void },
): Promise<ControlServer> {
  await assertPrivateDir(dataDir);
  const file = controlSocketPath(dataDir);
  try {
    const st = await lstat(file);
    if (!st.isSocket()) throw new PerchError(`${file} exists and is not a socket; remove it`, 'insecure_path');
    await unlink(file); // stale socket of a previous run
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const server: Server = createServer((socket) => {
    let listener: PairListener | null = null;
    let windowId: string | undefined;
    lines(socket, (line) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(line) as ClientMessage;
      } catch {
        return send(socket, { type: 'error', message: 'bad request' });
      }
      if (msg.op === 'open') {
        if (listener) return send(socket, { type: 'error', message: 'already open' });
        hooks.canOpen().then(
          () => {
            listener = (ev) => {
              hooks.onEvent?.(ev);
              send(socket, ev);
            };
            try {
              windowId = manager.open(listener).windowId;
            } catch (err) {
              listener = null;
              send(socket, { type: 'error', message: err instanceof PerchError ? err.message : 'cannot open a pairing window' });
            }
          },
          (err: unknown) => send(socket, { type: 'error', message: err instanceof PerchError ? err.message : 'cannot open a pairing window' }),
        );
      } else if (msg.op === 'answer' && typeof msg.approved === 'boolean') {
        try {
          manager.answer(msg.approved, windowId);
        } catch (err) {
          send(socket, { type: 'error', message: err instanceof PerchError ? err.message : 'cannot answer' });
        }
      }
    });
    socket.on('close', () => {
      manager.close('aborted', windowId);
      if (listener) manager.stopWatching(listener);
    });
    socket.on('error', () => socket.destroy());
  });
  const oldUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(oldUmask);
  }
  await chmod(file, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        unlink(file).catch(() => {});
      }),
  };
}

/** Client side (perch oauth pair): checks the socket file before connecting (Spec §12 item 18). */
export async function connectControl(dataDir: string): Promise<{ socket: Socket; onMessage: (fn: (msg: Record<string, unknown>) => void) => void; send: (m: ClientMessage) => void }> {
  await assertPrivateDir(dataDir);
  const file = controlSocketPath(dataDir);
  let st;
  try {
    st = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PerchError('No running public access server found (start perch serve --http --public first)', 'server_not_running');
    }
    throw err;
  }
  if (st.isSymbolicLink() || !st.isSocket()) throw new PerchError(`${file} is not a socket; refusing`, 'insecure_path');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new PerchError(`${file} belongs to another user; refusing`, 'insecure_path');
  if ((st.mode & 0o077) !== 0) throw new PerchError(`${file} is accessible by other users (mode ${(st.mode & 0o777).toString(8)}); refusing`, 'insecure_path');
  const socket = createConnection(file);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', () => reject(new PerchError('Could not connect to the running server', 'server_not_running')));
  });
  const handlers: Array<(msg: Record<string, unknown>) => void> = [];
  lines(socket, (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && typeof msg === 'object') for (const h of handlers) h(msg as Record<string, unknown>);
  });
  return { socket, onMessage: (fn) => handlers.push(fn), send: (m) => send(socket, m) };
}
