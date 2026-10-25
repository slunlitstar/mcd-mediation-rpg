import { createServer } from 'node:http';

import { handleApi } from './routes/api.js';
import { mcd } from './services/mcd.js';

const host = process.env.SERVER_HOST || '127.0.0.1';
const port = Number(process.env.SERVER_PORT || 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('SERVER_PORT must be an integer between 1 and 65535.');
}

const server = createServer((request, response) => {
  void (async (): Promise<void> => {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? `${host}:${String(port)}`}`,
    );

    if (await handleApi(request, response, url)) return;

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found\n');
  })().catch((error: unknown) => {
    console.error('[unhandled]', error);
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    response.end('Internal Server Error\n');
  });
});

server.listen(port, host, () => {
  console.info(`Server listening at http://${host}:${String(port)}`);
  console.info('Routes: GET /api/health | GET /api/stores | GET /api/menu | POST /api/plan | POST /api/mediate');
});

server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.info(`\n${signal} received, closing MCP session ...`);
    void mcd.close().finally(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  });
}
