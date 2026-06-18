type SoundKey =
  | 'apito'
  | 'apito-final'
  | 'palmas'
  | 'palmas2'
  | 'torcida'
  | 'torcida-calma'
  | 'chute-curto'
  | 'chute-longo';

const FILES: Record<SoundKey, string> = {
  'apito':          '/sounds/apito.wav',
  'apito-final':    '/sounds/apito-final.wav',
  'palmas':         '/sounds/palmas.wav',
  'palmas2':        '/sounds/palmas2.wav',
  'torcida':        '/sounds/torcida.wav',
  'torcida-calma':  '/sounds/torcida-calma.wav',
  'chute-curto':    '/sounds/chute-curto.wav',
  'chute-longo':    '/sounds/chute-longo.wav',
};

export class AudioManager {
  private buffers = new Map<SoundKey, AudioBuffer>();
  private ctx: AudioContext | null = null;
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdGain: GainNode | null = null;
  private lastKickAt = 0;
  private matchOver = false;

  constructor() {
    this.preload();
  }

  private getCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private async preload(): Promise<void> {
    const ctx = this.getCtx();
    await Promise.all(
      (Object.entries(FILES) as [SoundKey, string][]).map(async ([key, url]) => {
        try {
          const res = await fetch(url);
          const buf = await res.arrayBuffer();
          this.buffers.set(key, await ctx.decodeAudioData(buf));
        } catch {
          // arquivo não encontrado — sem crash
        }
      }),
    );
  }

  private play(key: SoundKey, volume = 1, loop = false): AudioBufferSourceNode | null {
    const ctx = this.getCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = this.buffers.get(key);
    if (!buf) return null;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.connect(gain);
    src.start();
    return src;
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  /** Apito de início de tempo (kickoff). */
  playWhistle(): void {
    this.play('apito', 0.9);
  }

  /** Apito final — encerra o jogo e para torcida de fundo permanentemente. */
  playFinalWhistle(): void {
    this.matchOver = true;
    this.stopCrowdAmbient();
    this.play('apito-final', 0.9);
  }

  /** Som de gol: palmas imediatas + torcida animada + volta ao ambiente. */
  playGoal(): void {
    this.stopCrowdAmbient();
    this.play(Math.random() < 0.5 ? 'palmas' : 'palmas2', 0.85);
    setTimeout(() => {
      this.play('torcida', 0.75);
      setTimeout(() => { if (!this.matchOver) this.startCrowdAmbient(); }, 4500);
    }, 350);
  }

  /**
   * Som de chute — power ≥ 12 = chute longo, < 12 = curto.
   * Debounce de 150ms para não soar múltiplas vezes por ação.
   */
  playKick(power: number): void {
    const now = performance.now();
    if (now - this.lastKickAt < 150) return;
    this.lastKickAt = now;
    this.play(power >= 12 ? 'chute-longo' : 'chute-curto', 0.6);
  }

  /** Inicia o loop de torcida de fundo. Idempotente. */
  startCrowdAmbient(): void {
    if (this.crowdSource) return;
    const ctx = this.getCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = this.buffers.get('torcida-calma');
    if (!buf) return;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.28;
    this.crowdGain.connect(ctx.destination);
    this.crowdSource = ctx.createBufferSource();
    this.crowdSource.buffer = buf;
    this.crowdSource.loop = true;
    this.crowdSource.connect(this.crowdGain);
    this.crowdSource.start();
  }

  /** Para o loop de torcida de fundo. */
  stopCrowdAmbient(): void {
    try { this.crowdSource?.stop(); } catch { /* já parou */ }
    this.crowdSource = null;
    this.crowdGain = null;
  }

  destroy(): void {
    this.stopCrowdAmbient();
    this.ctx?.close();
    this.ctx = null;
  }
}
