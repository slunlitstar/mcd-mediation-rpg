import { writeFile } from 'node:fs/promises';

// Vercel packages dist/ as the function root, so it needs its own ESM marker.
await writeFile(
  new URL('./dist/package.json', import.meta.url),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
);
