import type { LobbyMessage } from '../MultiplayerLobby';
import type { ChannelTransport, TransportStatus } from './ChannelTransport';

const BACKOFF_INITIAL = 1_000;
const BACKOFF_MAX = 30_000;

export class WebSocketTransport implements ChannelTransport {
  private ws!: WebSocket;
  private queue: string[] = [];
  private closed = false;
  private backoff = BACKOFF_INITIAL;
  private isFirstConnect = true;

  private readonly serverUrl: string;
  private readonly roomCode: string;

  onmessage: ((message: LobbyMessage) => void) | null = null;
  onstatuschange: ((status: TransportStatus) => void) | null = null;

  constructor(serverUrl: string, roomCode: string) {
    this.serverUrl = serverUrl;
    this.roomCode = roomCode;
    this.connect();
  }

  private connect(): void {
    const url = `${this.serverUrl}/room/${this.roomCode}`;
    console.log(`[ws] conectando → ${url}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log(`[ws] conexão aberta com ${url}`);
      this.backoff = BACKOFF_INITIAL;

      // Só dispara onstatuschange em reconexões (não na primeira conexão)
      if (!this.isFirstConnect) {
        console.log('[ws] reconectado — notificando app');
        this.onstatuschange?.('connected');
      }
      this.isFirstConnect = false;

      const pending = this.queue.splice(0);
      if (pending.length > 0) {
        console.log(`[ws] drenando ${pending.length} mensagem(ns) na fila`);
        pending.forEach((msg) => ws.send(msg));
      }
    });

    ws.addEventListener('message', (event) => {
      let parsed: LobbyMessage;
      try {
        parsed = JSON.parse(event.data as string) as LobbyMessage;
      } catch {
        console.warn('[ws] mensagem malformada ignorada:', event.data);
        return;
      }
      console.log(`[ws] ← recebido: "${parsed.type}"`);
      this.onmessage?.(parsed);
    });

    ws.addEventListener('close', (event) => {
      if (this.closed) {
        console.log('[ws] conexão encerrada intencionalmente');
        return;
      }
      console.warn(`[ws] conexão perdida (código ${event.code}) — reconectando em ${this.backoff}ms`);
      this.onstatuschange?.('reconnecting');
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, delay);
    });

    ws.addEventListener('error', (event) => {
      console.error('[ws] erro de conexão:', event);
    });
  }

  postMessage(message: LobbyMessage): void {
    const text = JSON.stringify(message);
    if (this.ws.readyState === WebSocket.OPEN) {
      console.log(`[ws] → enviando: "${message.type}"`);
      this.ws.send(text);
    } else {
      console.log(`[ws] → enfileirando "${message.type}" (ws não aberto, estado: ${this.ws.readyState})`);
      this.queue.push(text);
    }
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}
