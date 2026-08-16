import colyseus from 'colyseus';
import { GameState, PlayerState } from '@rocket-arena/shared/schema';
import { getConstant, setOverride, clearOverrides } from '@rocket-arena/shared/constants';
import type { InputPayload } from '@rocket-arena/shared/types';

const { Room } = colyseus;

/**
 * Dev-only sandbox room: starts immediately with 1 player.
 * No lock, no countdown. Phase goes straight to "playing" on first join.
 * Used for testing Tasks 8-16 without needing 4 players.
 */
export class SandboxRoom extends Room<GameState> {
  private inputs: Map<string, InputPayload> = new Map();

  onCreate(options: any) {
    this.setState(new GameState());
    this.maxClients = 4;
    this.setPatchRate(getConstant('NETCODE.PATCH_RATE_MS'));

    this.onMessage('input', (client, payload: InputPayload) => {
      this.inputs.set(client.sessionId, payload);
    });

    this.onMessage('dev-tune', (_client, data: { path: string; value: number }) => {
      try {
        setOverride(data.path, data.value);
      } catch (e: any) {
        console.warn(`[Dev] Failed: ${e.message}`);
      }
    });

    this.onMessage('dev-reset', () => {
      clearOverrides();
    });

    console.log('[SandboxRoom] Created (dev mode, instant start)');
  }

  onJoin(client: colyseus.Client, options: any) {
    const player = new PlayerState();
    player.name = options?.name || `Dev ${this.clients.length}`;

    const blueCount = Array.from(this.state.players.values()).filter(p => p.team === 'blue').length;
    player.team = blueCount < 2 ? 'blue' : 'orange';

    this.state.players.set(client.sessionId, player);

    // Immediately go to playing on first join
    if (this.state.phase === 'waiting') {
      this.state.phase = 'playing';
      this.state.timeRemaining = getConstant('MATCH.DURATION_SECONDS');
    }

    console.log(`[SandboxRoom] ${player.name} joined (phase: ${this.state.phase})`);
  }

  onLeave(client: colyseus.Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
  }

  onDispose() {
    console.log('[SandboxRoom] Disposed');
  }

  getInput(sessionId: string): InputPayload {
    return this.inputs.get(sessionId) || { throttle: 0, steer: 0, jump: false, boost: false };
  }
}
