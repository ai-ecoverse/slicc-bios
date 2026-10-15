#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

export const shapes = [
  ['a Bedrock key', /ABSK[A-Za-z0-9+/=]{8,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{8,}/],
  ['a GitHub token', /\bgithub_pat_[A-Za-z0-9_]{8,}/],
  ['an AWS key id', /\bAKIA[0-9A-Z]{12,}/],
  ['a private key', /-----BEGIN/],
];

export function scan(text, secrets = []) {
  const found = [];
  for (const secret of secrets) {
    if (secret && text.includes(secret)) found.push('a secret value');
  }
  for (const [what, shape] of shapes) {
    if (shape.test(text)) found.push(what);
  }
  return [...new Set(found)];
}

if (import.meta.url === `file://${argv[1]}`) {
  const text = await readFile(argv[2], 'utf8');
  const names = (env.CERT_SECRET_NAMES ?? '').split(',').filter(Boolean);
  const found = scan(
    text,
    names.map((name) => env[name])
  );
  if (found.length) {
    console.error(`secret-shaped content: ${found.join(', ')}`);
    exit(1);
  }
}
