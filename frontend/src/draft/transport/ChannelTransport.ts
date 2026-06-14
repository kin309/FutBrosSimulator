import type { LobbyMessage } from '../MultiplayerLobby';

export type TransportStatus = 'connected' | 'reconnecting';

export interface ChannelTransport {
  postMessage(message: LobbyMessage): void;
  onmessage: ((message: LobbyMessage) => void) | null;
  onstatuschange: ((status: TransportStatus) => void) | null;
  close(): void;
}
