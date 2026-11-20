import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const target = require.resolve('@ai-ecoverse/slicc-browsers/guard-runner.mjs');
const marker = 'REFUSED6_PROBE_PATCH';
const source = readFileSync(target, 'utf8');
if (source.includes(marker)) {
  process.stdout.write(`${marker} already applied\n`);
  process.exit(0);
}

const from = `      this.record(
        step,
        out,
        session,
        phase,
        Boolean(childSession) && !out.ok && this.detached(childSession)
      );
      if ((step.isolatedWorld || step.observer) && !out.ok)
        this.note(
          \`\${step.isolatedWorld ? \`isolatedWorld \${step.isolatedWorld}\` : \`observer \${step.observer}\`}: \${out.error?.message ?? 'failed'}\`
        );
      this.options.debug?.({ step, out, side: this.side });`;

const to = `      const replyAt = Date.now();
      const gone =
        Boolean(childSession) && !out.ok && this.detached(childSession);
      this.record(step, out, session, phase, gone);
      if ((step.isolatedWorld || step.observer) && !out.ok)
        this.note(
          \`\${step.isolatedWorld ? \`isolatedWorld \${step.isolatedWorld}\` : \`observer \${step.observer}\`}: \${out.error?.message ?? 'failed'}\`
        );
      let detachAt;
      let childUrl;
      if (session) {
        const events = this.client.events.slice(this.eventStart);
        for (let i = events.length - 1; i >= 0; i--) {
          const event = events[i];
          if (
            detachAt === undefined &&
            event.method === 'Target.detachedFromTarget' &&
            event.params?.sessionId === session
          )
            detachAt = event.__at;
          if (
            childUrl === undefined &&
            event.method === 'Page.frameNavigated' &&
            event.sessionId === session &&
            event.params?.frame &&
            !event.params.frame.parentId
          )
            childUrl = event.params.frame.url;
          if (
            childUrl === undefined &&
            event.method === 'Target.attachedToTarget' &&
            event.params?.sessionId === session
          )
            childUrl = event.params.targetInfo?.url;
        }
      }
      this.options.debug?.({
        step,
        out,
        side: this.side,
        session,
        phase,
        gone,
        replyAt,
        detachAt,
        childUrl,
        /* ${marker} */
      });`;

if (!source.includes(from)) {
  process.stderr.write('refused6-probe-patch: expected execute() debug block not found\n');
  process.exit(1);
}
writeFileSync(target, source.replace(from, to));
process.stdout.write(`${marker} applied to ${target}\n`);
