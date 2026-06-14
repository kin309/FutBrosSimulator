import type { LobbyMessage } from '../MultiplayerLobby';
import type { ChannelTransport, TransportStatus } from './ChannelTransport';

export class BroadcastChannelTransport implements ChannelTransport {
  private readonly channel: BroadcastChannel;
  onmessage: ((message: LobbyMessage) => void) | null = null;
  // BroadcastChannel é sempre local — status change não se aplica
  onstatuschange: ((status: TransportStatus) => void) | null = null;

  constructor(channelName: string) {
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (event: MessageEvent<LobbyMessage>) => {
      this.onmessage?.(event.data);
    };
  }

  postMessage(message: LobbyMessage): void {
    this.channel.postMessage(message);
  }

  close(): void {
    this.channel.close();
  }
}
