import colyseus from 'colyseus';
import { GameState, PlayerState } from '@rocket-arena/shared/schema';
import { getConstant, setOverride, clearOverrides } from '@rocket-arena/shared/constants';
import type { InputPayload } from '@rocket-arena/shared/types';

const { Room } = colyseus;

export class ArenaRoom extends Room<GameState> {
  private inputs: Map<string, InputPayload> = new Map();
  private countdownTimer: number = 0;

  onCreate(options: any) {
    this.setState(new GameState());
    this.maxClients = getConstant('MATCH.MAX_PLAYERS');
    this.setPatchRate(getConstant('NETCODE.PATCH_RATE_MS'));

    // Handle input messages
    this.onMessage('input', (client, payload: InputPayload) => {
      this.inputs.set(client.sessionId, payload);
    });

    // Handle dev-tune messages (dev only)
    this.onMessage('dev-tune', (_client, data: { path: string; value: number }) => {
      try {
        setOverride(data.path, data.value);
        console.log(`[Dev] Override: ${data.path} = ${data.value}`);
      } catch (e: any) {
        console.warn(`[Dev] Failed to override: ${e.message}`);
      }
    });

    this.onMessage('dev-reset', () => {
      clearOverrides();
      console.log('[Dev] All overrides cleared');
    });

    console.log(`[ArenaRoom] Created (max ${this.maxClients} players, patch rate ${getConstant('NETCODE.PATCH_RATE_MS')}ms)`);
  }

  onJoin(client: colyseus.Client, options: any) {
    const player = new PlayerState();
    player.name = options?.name || `Player ${this.clients.length}`;

    // Assign team: first 2 = blue, next 2 = orange
    const blueCount = Array.from(this.state.players.values()).filter(p => p.team === 'blue').length;
    player.team = blueCount < getConstant('MATCH.TEAM_SIZE') ? 'blue' : 'orange';

    this.state.players.set(client.sessionId, player);
    console.log(`[ArenaRoom] ${player.name} joined team ${player.team} (${this.clients.length}/${this.maxClients})`);

    // Check if room is full -> start countdown
    if (this.clients.length >= this.maxClients) {
      this.lock();
      this.startCountdown();
    }
  }

  onLeave(client: colyseus.Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(`[ArenaRoom] ${player.name} left`);
    }
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
  }

  onDispose() {
    console.log('[ArenaRoom] Disposed');
  }

  private startCountdown() {
    this.state.phase = 'countdown';
    this.countdownTimer = getConstant('MATCH.COUNTDOWN_SECONDS');
    console.log(`[ArenaRoom] Room full! Countdown: ${this.countdownTimer}s`);
  }

  getInput(sessionId: string): InputPayload {
    return this.inputs.get(sessionId) || { throttle: 0, steer: 0, jump: false, boost: false };
  }
}
