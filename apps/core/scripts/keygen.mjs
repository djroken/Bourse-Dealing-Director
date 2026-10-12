#!/usr/bin/env node
// Prints a fresh master key for the encrypted secret store. Put it in your shell or a git-ignored .env, never in the repo.
import { randomBytes } from 'node:crypto';
console.log(randomBytes(32).toString('hex'));
console.error('\nExport it before starting core:  export BOURSE_MASTER_KEY=<the value above>\nLose it and stored secrets cannot be recovered.');
