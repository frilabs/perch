import type { PasteRedirect } from '../oauth/loopback.js';

/**
 * Terminal side of every loopback OAuth login (Google, Microsoft, Luma; docs/GUIDED_PROVIDER_SETUP_SPEC.md §2):
 * prints the login link and, with a terminal, also accepts the pasted address the browser could not open, so no
 * SSH tunnel is needed. The tunnel stays as the alternative.
 */
export interface LoginPromptIo {
  stderr: (s: string) => void;
  /** Hidden, cancellable one-line paste; resolves undefined without a terminal. */
  readPastedUrl?: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
}

export function loginPrompts(io: LoginPromptIo, what: string, timeoutMs: number): { onAuthUrl: (url: string) => void; paste?: PasteRedirect } {
  const canPaste = Boolean(io.readPastedUrl);
  const onAuthUrl = (url: string) => {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
    const p = redirect.port;
    io.stderr(
      `Open this URL in a browser and ${what}:\n\n${url}\n\n` +
        (canPaste
          ? `After you approved, the browser tries to open ${redirect.host} and shows "This site can't be reached" (unless it runs\n` +
            'on this machine). That is expected: copy the complete address from its address bar (it contains\n' +
            `port ${p}) and paste it here.\n` +
            `Or: forward the port first and the login completes by itself: ssh -N -L ${p}:127.0.0.1:${p} <this-server>\n`
          : `The browser must reach port ${p} on this machine (loopback). If the browser runs elsewhere, ` +
            `forward the port first: ssh -N -L ${p}:127.0.0.1:${p} <this-server>\n`) +
        `Waiting up to ${Math.round(timeoutMs / 1000)}s...\n`,
    );
  };
  const read = io.readPastedUrl;
  if (!read) return { onAuthUrl };
  return {
    onAuthUrl,
    paste: {
      read: (signal) => read('Address from the browser (input hidden; Enter after pasting): ', signal),
      onRejected: (reason) => io.stderr(`${reason}. Paste the complete address again, or wait for the login to finish by itself.\n`),
    },
  };
}
