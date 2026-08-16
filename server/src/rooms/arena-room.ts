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

export class ArenaRoom extends Room<GameState> {
  private inputs: Map<string, InputPayload> = new Map();
  private countdownTimer: number = 0;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private world!: RAPIER.World;
  private ballBody!: RAPIER.RigidBody;
  private carBodies: Map<string, CarEntry> = new Map();
  private physicsReady: boolean = false;

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

    // Initialize physics (world created but sim loop won't start until countdown finishes)
    this.initializePhysics();

    console.log(`[ArenaRoom] Created (max ${this.maxClients} players, patch rate ${getConstant('NETCODE.PATCH_RATE_MS')}ms)`);
  }

  private async initializePhysics() {
    await initPhysics();
    this.world = createWorld();
    createArenaColliders(this.world);
    this.ballBody = createBall(this.world);
    this.physicsReady = true;

    console.log('[ArenaRoom] Physics initialized (waiting for players)');
  }

  onJoin(client: colyseus.Client, options: any) {
    const player = new PlayerState();
    player.name = options?.name || `Player ${this.clients.length}`;

    // Assign team: first 2 = blue, next 2 = orange
    const blueCount = Array.from(this.state.players.values()).filter(p => p.team === 'blue').length;
    player.team = blueCount < getConstant('MATCH.TEAM_SIZE') ? 'blue' : 'orange';

    this.state.players.set(client.sessionId, player);

    // Create car body at kickoff position
    this.spawnCar(client.sessionId, player.team);

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
    this.removeCar(client.sessionId);
  }

  onDispose() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    if (this.world) {
      this.world.free();
    }
    console.log('[ArenaRoom] Disposed');
  }

  private startCountdown() {
    this.state.phase = 'countdown';
    this.countdownTimer = getConstant('MATCH.COUNTDOWN_SECONDS');
    this.state.timeRemaining = this.countdownTimer;
    console.log(`[ArenaRoom] Room full! Countdown: ${this.countdownTimer}s`);

    this.countdownInterval = setInterval(() => {
      this.countdownTimer--;
      this.state.timeRemaining = this.countdownTimer;

      if (this.countdownTimer <= 0) {
        if (this.countdownInterval) {
          clearInterval(this.countdownInterval);
          this.countdownInterval = null;
        }
        this.startMatch();
      }
    }, 1000);
  }

  private startMatch() {
    this.state.phase = 'playing';
    this.state.timeRemaining = getConstant('MATCH.DURATION_SECONDS');

    // Start 60Hz physics loop
    this.setSimulationInterval((dt) => this.tick(dt), 1000 / 60);

    console.log('[ArenaRoom] Match started! Physics loop running at 60Hz');
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
    const y = carHeight / 2 + 0.1;

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
