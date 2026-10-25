import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const host = process.env.SERVER_HOST || '127.0.0.1';
const port = Number(process.env.SERVER_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SERVER_PORT must be an integer between 1 and 65535.');

type Participant = { id: string; name: string; joinedAt: string };
type Order = { id: string; participantId: string; itemId: string; quantity: number };
type Room = { id: string; status: 'open' | 'ready'; createdAt: string; participants: Participant[]; orders: Order[] };
const menu = [
  { id: 'big-mac', name: '巨无霸', price: 25, category: '汉堡' },
  { id: 'mc-wings', name: '麦辣鸡翅', price: 13, category: '小食' },
  { id: 'fries-medium', name: '中薯条', price: 12, category: '小食' },
  { id: 'coke-medium', name: '中可乐', price: 11, category: '饮料' },
];
const rooms = new Map<string, Room>();
function sendJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); response.end(JSON.stringify(body)); }
function sendError(response: ServerResponse, status: number, message: string): void { sendJson(response, status, { error: { code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message } }); }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { let data = ''; for await (const chunk of request) data += chunk; if (!data) return {}; const body: unknown = JSON.parse(data); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象。'); return body as Record<string, unknown>; }
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method || 'GET'; const url = new URL(request.url || '/', `http://${host}:${port}`); const parts = url.pathname.split('/').filter(Boolean);
  if (method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); response.end(); return; }
  if (method === 'GET' && url.pathname === '/health') { sendJson(response, 200, { ok: true, service: 'mcd-server', timestamp: new Date().toISOString() }); return; }
  if (method === 'GET' && url.pathname === '/api/menu') { sendJson(response, 200, { items: menu }); return; }
  if (method === 'POST' && url.pathname === '/api/rooms') { const body = await readJson(request); const room: Room = { id: randomUUID().slice(0, 8), status: 'open', createdAt: new Date().toISOString(), participants: [], orders: [] }; if (typeof body.hostName === 'string' && body.hostName.trim()) room.participants.push({ id: randomUUID().slice(0, 8), name: body.hostName.trim(), joinedAt: new Date().toISOString() }); rooms.set(room.id, room); sendJson(response, 201, { room }); return; }
  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) { sendError(response, 404, '接口不存在。'); return; }
  const room = rooms.get(parts[2]); if (!room) { sendError(response, 404, '房间不存在。'); return; }
  if (method === 'GET' && parts.length === 3) { sendJson(response, 200, { room }); return; }
  if (method === 'POST' && parts[3] === 'participants') { const body = await readJson(request); if (typeof body.name !== 'string' || !body.name.trim()) { sendError(response, 400, 'name 必须是非空字符串。'); return; } const participant = { id: randomUUID().slice(0, 8), name: body.name.trim(), joinedAt: new Date().toISOString() }; room.participants.push(participant); sendJson(response, 201, { participant, room }); return; }
  if (method === 'POST' && parts[3] === 'orders') { const body = await readJson(request); const participantId = typeof body.participantId === 'string' ? body.participantId : ''; const itemId = typeof body.itemId === 'string' ? body.itemId : ''; const quantity = typeof body.quantity === 'number' ? body.quantity : 1; if (!room.participants.some((participant) => participant.id === participantId)) { sendError(response, 400, 'participantId 不属于当前房间。'); return; } if (!menu.some((item) => item.id === itemId)) { sendError(response, 400, 'itemId 不存在。'); return; } if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) { sendError(response, 400, 'quantity 必须是 1 到 20 的整数。'); return; } const order = { id: randomUUID().slice(0, 8), participantId, itemId, quantity }; room.orders.push(order); sendJson(response, 201, { order, room }); return; }
  sendError(response, 404, '接口不存在。');
}
const server = createServer((request, response) => { handle(request, response).catch((error: unknown) => { const message = error instanceof SyntaxError ? '请求体不是合法 JSON。' : error instanceof Error ? error.message : '服务器内部错误。'; sendError(response, 400, message); }); });
server.listen(port, host, () => console.info(`Server listening at http://${host}:${port}`));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
