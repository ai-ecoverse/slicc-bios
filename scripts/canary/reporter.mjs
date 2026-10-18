import { relative } from 'node:path';
import { cwd } from 'node:process';

const LOG = 4000;

function message(error) {
  if (!error) return '';
  const cause = error.cause ?? error;
  const text = [cause.message ?? String(cause), cause.stack?.split('\n').slice(1, 6).join('\n')]
    .filter(Boolean)
    .join('\n');
  return text.length > LOG ? `${text.slice(0, LOG)}…` : text;
}

export default async function* canaryReporter(source) {
  const open = new Map();
  for await (const { type, data } of source) {
    if (type !== 'test:start' && type !== 'test:pass' && type !== 'test:fail') continue;
    const file = data.file ? relative(cwd(), data.file) : '';
    const path = [...(open.get(file) ?? []).slice(0, data.nesting), data.name];
    if (type === 'test:start') {
      open.set(file, path);
      continue;
    }
    if (data.details?.type === 'suite' && type === 'test:pass') continue;
    const skipped = data.skip !== undefined || data.todo !== undefined;
    const status = type === 'test:fail' ? 'fail' : skipped ? 'skip' : 'pass';
    yield `${JSON.stringify({
      file,
      name: data.name,
      nesting: data.nesting,
      path,
      status,
      durationMs: Math.round(data.details?.duration_ms ?? 0),
      log: status === 'fail' ? message(data.details?.error) : '',
    })}\n`;
  }
}
