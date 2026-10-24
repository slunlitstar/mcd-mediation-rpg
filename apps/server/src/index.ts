import { createServer } from 'node:http';

const host = process.env.SERVER_HOST || '127.0.0.1';
const port = Number(process.env.SERVER_PORT || 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('SERVER_PORT must be an integer between 1 and 65535.');
}

// Infrastructure placeholder only. Business routes will be added in later work.
const server = createServer((_request, response) => {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not Found\n');
});

server.listen(port, host, () => {
  console.info(`Server scaffold listening at http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
