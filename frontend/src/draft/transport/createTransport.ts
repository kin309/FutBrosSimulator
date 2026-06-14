import { BroadcastChannelTransport } from './BroadcastChannelTransport';
import { WebSocketTransport } from './WebSocketTransport';
import type { ChannelTransport } from './ChannelTransport';

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined)?.replace(/\/$/, '');

export function createTransport(roomCode: string): ChannelTransport {
  if (WS_URL) {
    console.log(`[transport] WebSocket → ${WS_URL}/room/${roomCode}`);
    return new WebSocketTransport(WS_URL, roomCode);
  }
  console.warn('[transport] VITE_WS_URL não definido — usando BroadcastChannel (só funciona na mesma aba)');
  return new BroadcastChannelTransport(`football-sim-room-${roomCode}`);
}
