import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';

const options = {
  roots: [['/', 'src/']],
  aliases: [['/os/', 'src/seed/']],
  intercept: ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'],
  timeout: 90000,
};

export const launch = (overrides) => start({ ...options, ...overrides });

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ ...options, port: Number(env.PORT ?? 8080) });
  console.log(`slicc-bios on ${url}`);
}
