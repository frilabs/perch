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

/** Word-wraps one line of prose at `width` columns (terminal output; words are never split). */
export function wrap(text: string, width = 80): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.join('\n');
}

export function loginPrompts(
  io: LoginPromptIo,
  what: string,
  timeoutMs: number,
  /** Extra paragraph after the link (e.g. which app name the consent screen shows); ends with a newline. */
  note?: string,
): { onAuthUrl: (url: string) => void; paste?: PasteRedirect } {
  const canPaste = Boolean(io.readPastedUrl);
  const onAuthUrl = (url: string) => {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
    const p = redirect.port;
    io.stderr(
      `${wrap(`Open this URL in a browser and ${what}:`)}\n\n${url}\n\n` +
        (note ? `${note}\n` : '') +
        (canPaste
          ? `After you approved, the browser tries to open ${redirect.host} and shows\n` +
            '"This site can\'t be reached" (unless it runs on this machine). That is\n' +
            'expected: copy the complete address from its address bar (it contains\n' +
            `port ${p}) and paste it here.\n` +
            'Or: forward the port first and the login completes by itself:\n' +
            `  ssh -N -L ${p}:127.0.0.1:${p} <this-server>\n`
          : `The browser must reach port ${p} on this machine (loopback). If the browser\n` +
            'runs elsewhere, forward the port first:\n' +
            `  ssh -N -L ${p}:127.0.0.1:${p} <this-server>\n`) +
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
