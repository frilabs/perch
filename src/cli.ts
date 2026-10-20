#!/usr/bin/env node
import { readLineFromTty, readSecretFromTty } from './cli/prompt.js';
import { runCli } from './cli/run.js';

process.umask(0o077);

runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readSecret: readSecretFromTty,
  readLine: readLineFromTty,
  stdoutIsTTY: process.stdout.isTTY === true,
  ...(process.stdout.columns ? { stdoutColumns: process.stdout.columns } : {}),
}).then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('perch: fatal error\n');
    process.exit(1);
  },
);
