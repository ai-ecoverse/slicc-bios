import { env } from 'node:process';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';

const options = {
  roots: [['/', 'src/']],
  aliases: [['/os/', 'src/seed/']],
  intercept: ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'],
};

export const launch = () => start(options);

if (import.meta.main) {
  const { url } = await serve({ ...options, port: Number(env.PORT ?? 8080) });
  console.log(`slicc-bios on ${url}`);
}
