import { homedir } from 'node:os';
import path from 'node:path';
import { PerchError } from './errors.js';
import { readPrivateFile } from './secureFs.js';

export interface PerchConfig {
  dataDir: string;
  keyFile: string;
  tokenFile: string;
  /** Token from PERCH_HTTP_TOKEN (takes precedence over the token file). */
  httpTokenEnv?: string;
  httpHost: string;
  httpPort: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  googleClientFile?: string;
  /** Application (client) ID of the Entra app registration (public client; not a secret). */
  microsoftClientId?: string;
  /** Entra tenant for sign-in: common (default), consumers, organizations, a tenant GUID or domain. */
  microsoftTenant: string;
  /** stdio only: client token file selecting a client grant (default stdio is read-only). */
  clientTokenFile?: string;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Configuration comes from environment variables only (no secrets on the command line). */
export function resolveConfig(env: Record<string, string | undefined>): PerchConfig {
  const home = homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const port = Number(env.PERCH_HTTP_PORT || '8765');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PerchError('PERCH_HTTP_PORT must be a valid port', 'bad_config');
  return {
    dataDir: path.resolve(env.PERCH_DATA_DIR || path.join(dataHome, 'perch')),
    keyFile: path.resolve(env.PERCH_KEY_FILE || path.join(configHome, 'perch', 'store.key')),
    tokenFile: path.resolve(env.PERCH_HTTP_TOKEN_FILE || path.join(configHome, 'perch', 'http-token')),
    ...(env.PERCH_HTTP_TOKEN ? { httpTokenEnv: env.PERCH_HTTP_TOKEN } : {}),
    httpHost: env.PERCH_HTTP_HOST || '127.0.0.1',
    httpPort: port,
    allowedHosts: list(env.PERCH_ALLOWED_HOSTS),
    allowedOrigins: list(env.PERCH_ALLOWED_ORIGINS),
    ...(env.PERCH_GOOGLE_CLIENT_FILE ? { googleClientFile: path.resolve(env.PERCH_GOOGLE_CLIENT_FILE) } : {}),
    ...(env.PERCH_MICROSOFT_CLIENT_ID ? { microsoftClientId: env.PERCH_MICROSOFT_CLIENT_ID.trim() } : {}),
    microsoftTenant: env.PERCH_MICROSOFT_TENANT?.trim() || 'common',
    ...(env.PERCH_CLIENT_TOKEN_FILE ? { clientTokenFile: path.resolve(env.PERCH_CLIENT_TOKEN_FILE) } : {}),
  };
}

export async function loadHttpToken(config: PerchConfig): Promise<string> {
  if (config.httpTokenEnv) return config.httpTokenEnv;
  try {
    return (await readPrivateFile(config.tokenFile)).toString('utf8').trim();
  } catch (err) {
    if (err instanceof PerchError && err.code === 'not_found') {
      throw new PerchError(`No HTTP bearer token at ${config.tokenFile}. Run \`perch init\` or \`perch token rotate\`.`, 'no_token');
    }
    throw err;
  }
}
