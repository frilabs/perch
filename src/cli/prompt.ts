import { PerchError } from '../errors.js';

/**
 * Reads a secret from the controlling terminal without echoing it (one `*` per character).
 * Refuses to run without a TTY so secrets never come from arguments, pipes or shell history.
 */
export function readSecretFromTty(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new PerchError('A secret prompt needs an interactive TTY; run this command in a terminal', 'no_tty'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new PerchError('Aborted', 'aborted'));
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          process.stderr.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}
