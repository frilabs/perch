#!/usr/bin/env node
import { readSecretFromTty } from './cli/prompt.js';
import { runCli } from './cli/run.js';

process.umask(0o077);

runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readSecret: readSecretFromTty,
}).then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('perch: fatal error\n');
    process.exit(1);
  },
);
