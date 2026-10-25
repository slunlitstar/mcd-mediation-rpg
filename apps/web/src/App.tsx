import { useEffect, useState } from 'react';

type MenuItem = { id: string; name: string; price: number; category: string };
type Participant = { id: string; name: string; joinedAt: string };
type Room = { id: string; status: string; participants: Participant[]; orders: { id: string; itemId: string; quantity: number }[] };
const API = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3001';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `请求失败（${response.status}）`);
  return data;
}

export default function App() {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('正在连接后端…');
  const [loading, setLoading] = useState(false);
  useEffect(() => { api<{ items: MenuItem[] }>('/api/menu').then(({ items }) => { setMenu(items); setMessage('后端已连接，可以开始联调'); }).catch((error: Error) => setMessage(error.message)); }, []);
  async function createRoom() { setLoading(true); try { const data = await api<{ room: Room }>('/api/rooms', { method: 'POST', body: JSON.stringify({ hostName: name || '房主' }) }); setRoom(data.room); setMessage(`房间已创建：${data.room.id}`); } catch (error) { setMessage((error as Error).message); } finally { setLoading(false); } }
  async function addOrder(itemId: string) { if (!room?.participants[0]) { setMessage('请先创建房间'); return; } setLoading(true); try { const data = await api<{ room: Room }>(`/api/rooms/${room.id}/orders`, { method: 'POST', body: JSON.stringify({ participantId: room.participants[0].id, itemId, quantity: 1 }) }); setRoom(data.room); setMessage('点餐已提交'); } catch (error) { setMessage((error as Error).message); } finally { setLoading(false); } }
  return <main><section className="hero"><p className="eyebrow">MCD MEDIATION RPG · 联调面板</p><h1>麦门饭局调解所</h1><p>第三轮前端已接入第二轮后端接口。</p><span className={message.includes('连接') || message.includes('创建') || message.includes('提交') ? 'status ok' : 'status'}>{message}</span></section><section className="panel"><h2>创建饭局</h2><div className="form-row"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入你的名字" /><button onClick={createRoom} disabled={loading}>创建房间</button></div>{room && <div className="room"><strong>房间 {room.id}</strong><span>参与者：{room.participants.map((item) => item.name).join('、')}</span><span>订单数：{room.orders.length}</span></div>}</section><section className="panel"><div className="section-title"><h2>菜单</h2><span>{menu.length} 个接口数据项</span></div><div className="menu-grid">{menu.map((item) => <button className="menu-card" key={item.id} onClick={() => addOrder(item.id)} disabled={loading}><span>{item.category}</span><strong>{item.name}</strong><b>¥{item.price}</b></button>)}</div></section></main>;
}
