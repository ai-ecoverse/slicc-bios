#!/usr/bin/env node
import { argv, env, exit } from 'node:process';
import { scan } from './scan.mjs';

export async function probe(model, { region, token, fetcher = fetch }) {
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: 'Reply with OK.' }] }],
        inferenceConfig: { maxTokens: 8 },
      }),
    });
    const text = await response.text();
    let message = '';
    if (!response.ok) {
      try {
        message = JSON.parse(text).message ?? text;
      } catch {
        message = text;
      }
    }
    return { model, status: response.status, ok: response.ok, message: tidy(message, token) };
  } catch (error) {
    return { model, status: 0, ok: false, message: tidy(error.message, token) };
  }
}

export function tidy(message, token) {
  const short = String(message)
    .replaceAll(token || '\u0000', '[token]')
    .slice(0, 300);
  return scan(short).length ? '[withheld: secret-shaped]' : short;
}

if (import.meta.url === `file://${argv[1]}`) {
  const region = env.REGION ?? 'us-west-2';
  const token = env.AWS_BEARER_TOKEN_BEDROCK ?? '';
  if (!token) {
    console.error('AWS_BEARER_TOKEN_BEDROCK is empty in this job');
    exit(1);
  }
  const results = [];
  for (const model of argv.slice(2)) results.push(await probe(model, { region, token }));
  for (const { model, status, message } of results) {
    console.log(`${model} in ${region}: HTTP ${status}${message ? `: ${message}` : ''}`);
  }
  if (!results[0]?.ok) exit(1);
}
