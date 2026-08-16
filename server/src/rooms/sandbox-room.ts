import colyseus from 'colyseus';
import RAPIER from '@dimforge/rapier3d-compat';
import { GameState, PlayerState } from '@rocket-arena/shared/schema';
import { getConstant, setOverride, clearOverrides } from '@rocket-arena/shared/constants';
import type { InputPayload } from '@rocket-arena/shared/types';
import { initPhysics, createWorld } from '../physics/world.js';
import { createArenaColliders } from '../physics/arena.js';
import { createBall } from '../physics/ball.js';
import { createCar, applyCarPhysics } from '../physics/car.js';

const { Room } = colyseus;

interface CarEntry {
  body: RAPIER.RigidBody;
  jumpState: { count: number };
}

/**
 * Dev-only sandbox room: starts immediately with 1 player.
 * No lock, no countdown. Phase goes straight to "playing" on first join.
 * Used for testing Tasks 8-16 without needing 4 players.
 */
export class SandboxRoom extends Room<GameState> {
  private inputs: Map<string, InputPayload> = new Map();
  private world!: RAPIER.World;
  private ballBody!: RAPIER.RigidBody;
  private carBodies: Map<string, CarEntry> = new Map();
  private physicsReady: boolean = false;

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

    // Initialize physics asynchronously then start the simulation loop
    this.initializePhysics();

    console.log('[SandboxRoom] Created (dev mode, instant start)');
  }

  private async initializePhysics() {
    await initPhysics();
    this.world = createWorld();
    createArenaColliders(this.world);
    this.ballBody = createBall(this.world);
    this.physicsReady = true;

    // Start 60Hz physics loop
    this.setSimulationInterval((dt) => this.tick(dt), 1000 / 60);

    console.log('[SandboxRoom] Physics initialized, 60Hz loop started');
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

    // Create car body at kickoff position once physics is ready
    this.spawnCar(client.sessionId, player.team);

    console.log(`[SandboxRoom] ${player.name} joined (phase: ${this.state.phase})`);
  }

  onLeave(client: colyseus.Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.removeCar(client.sessionId);
  }

  onDispose() {
    if (this.world) {
      this.world.free();
    }
    console.log('[SandboxRoom] Disposed');
  }

  private spawnCar(sessionId: string, team: string) {
    if (!this.physicsReady) {
      // Defer spawn until physics is ready
      const interval = setInterval(() => {
        if (this.physicsReady) {
          clearInterval(interval);
          this.createCarBody(sessionId, team);
        }
      }, 50);
      return;
    }
    this.createCarBody(sessionId, team);
  }

  private createCarBody(sessionId: string, team: string) {
    const pos = this.getKickoffPosition(sessionId, team);
    const rotation = team === 'orange'
      ? { x: 0, y: 1, z: 0, w: 0 }  // Face toward blue goal (180° around Y)
      : { x: 0, y: 0, z: 0, w: 1 };  // Face toward orange goal (default)

    const body = createCar(this.world, pos, rotation);
    this.carBodies.set(sessionId, { body, jumpState: { count: 0 } });

    // Set initial player position in schema
    const player = this.state.players.get(sessionId);
    if (player) {
      player.x = pos.x;
      player.y = pos.y;
      player.z = pos.z;
      player.qx = rotation.x;
      player.qy = rotation.y;
      player.qz = rotation.z;
      player.qw = rotation.w;
    }
  }

  private getKickoffPosition(sessionId: string, team: string): { x: number; y: number; z: number } {
    const carHeight = getConstant('CAR.BODY.HEIGHT');
    const y = carHeight / 2 + 0.1; // Slightly above floor

    // Count how many players are already on this team (for X offset sign)
    const teamPlayers = Array.from(this.state.players.entries())
      .filter(([id, p]) => p.team === team && id !== sessionId);
    const isSecondPlayer = teamPlayers.length > 0;

    if (team === 'blue') {
      const xOffset = getConstant('ARENA.KICKOFF.BLUE_X_OFFSET');
      const zOffset = getConstant('ARENA.KICKOFF.BLUE_Z_OFFSET');
      return {
        x: isSecondPlayer ? -xOffset : xOffset,
        y,
        z: zOffset,
      };
    } else {
      const xOffset = getConstant('ARENA.KICKOFF.ORANGE_X_OFFSET');
      const zOffset = getConstant('ARENA.KICKOFF.ORANGE_Z_OFFSET');
      return {
        x: isSecondPlayer ? -xOffset : xOffset,
        y,
        z: zOffset,
      };
    }
  }

  private removeCar(sessionId: string) {
    const entry = this.carBodies.get(sessionId);
    if (entry && this.world) {
      this.world.removeRigidBody(entry.body);
      this.carBodies.delete(sessionId);
    }
  }

  private tick(dt: number) {
    if (!this.physicsReady) return;

    // 1. Apply car physics from player inputs
    for (const [sessionId, carEntry] of this.carBodies) {
      const input = this.inputs.get(sessionId) || { throttle: 0, steer: 0, jump: false, boost: false };
      applyCarPhysics(this.world, carEntry.body, input, carEntry.jumpState);
    }

    // 2. Step the Rapier world
    this.world.step();

    // 3. Sync physics state to Colyseus schema
    this.syncBallState();
    this.syncPlayerStates();
  }

  private syncBallState() {
    const ballPos = this.ballBody.translation();
    const ballRot = this.ballBody.rotation();
    const ballVel = this.ballBody.linvel();

    this.state.ball.x = ballPos.x;
    this.state.ball.y = ballPos.y;
    this.state.ball.z = ballPos.z;
    this.state.ball.qx = ballRot.x;
    this.state.ball.qy = ballRot.y;
    this.state.ball.qz = ballRot.z;
    this.state.ball.qw = ballRot.w;
    this.state.ball.vx = ballVel.x;
    this.state.ball.vy = ballVel.y;
    this.state.ball.vz = ballVel.z;
  }

  private syncPlayerStates() {
    for (const [sessionId, carEntry] of this.carBodies) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;

      const pos = carEntry.body.translation();
      const rot = carEntry.body.rotation();
      const vel = carEntry.body.linvel();

      player.x = pos.x;
      player.y = pos.y;
      player.z = pos.z;
      player.qx = rot.x;
      player.qy = rot.y;
      player.qz = rot.z;
      player.qw = rot.w;
      player.vx = vel.x;
      player.vy = vel.y;
      player.vz = vel.z;
    }
  }

  getInput(sessionId: string): InputPayload {
    return this.inputs.get(sessionId) || { throttle: 0, steer: 0, jump: false, boost: false };
  }
}
