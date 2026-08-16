import colyseus from 'colyseus';
import RAPIER from '@dimforge/rapier3d-compat';
import { GameState, PlayerState } from '@rocket-arena/shared/schema';
import { getConstant, setOverride, clearOverrides } from '@rocket-arena/shared/constants';
import type { InputPayload } from '@rocket-arena/shared/types';
import { initPhysics, createWorld } from '../physics/world.js';
import { createArenaColliders } from '../physics/arena.js';
import { createBall } from '../physics/ball.js';
import { createCar, applyCarPhysics, createCarPhysicsState, type CarPhysicsState } from '../physics/car.js';
import { createGoalSensors, checkGoal, resetToKickoff } from '../systems/scoring.js';
import { updateTimer, resolveTimeUp, getGoalResetDelay } from '../systems/match-timer.js';

const { Room } = colyseus;

interface CarEntry {
  body: RAPIER.RigidBody;
  jumpState: CarPhysicsState;
}

/**
 * Quick Match room — auto-assigns teams, starts when 4/4 players.
 * Uses manual broadcast-based state sync instead of Colyseus auto-patching.
 */
export class ArenaRoom extends Room<GameState> {
  private inputs: Map<string, InputPayload> = new Map();
  private countdownTimer: number = 0;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private world!: RAPIER.World;
  private ballBody!: RAPIER.RigidBody;
  private carBodies: Map<string, CarEntry> = new Map();
  private physicsReady: boolean = false;
  private goalResetTimer: number = 0;
  private wasOvertime: boolean = false;

  onCreate(options: any) {
    this.setState(new GameState());
    this.maxClients = getConstant('MATCH.MAX_PLAYERS');
    this.setPatchRate(getConstant('NETCODE.PATCH_RATE_MS'));

    // Handle input messages
    this.onMessage('input', (client, payload: InputPayload) => {
      this.inputs.set(client.sessionId, payload);
    });

    // Handle dev-tune messages
    this.onMessage('dev-tune', (_client, data: { path: string; value: number }) => {
      try {
        setOverride(data.path, data.value);
      } catch (e: any) {
        console.warn(`[Dev] Failed to override: ${e.message}`);
      }
    });

    this.onMessage('dev-reset', () => {
      clearOverrides();
    });

    // Initialize physics
    this.initializePhysics();

    // Single simulation interval running from the start at 30Hz.
    // During active play, physics steps at 60Hz (we'll switch interval rate).
    this.setSimulationInterval(() => {
      if (this.physicsReady && (this.state.phase === 'playing' || this.state.phase === 'overtime' || this.state.phase === 'goal-scored')) {
        this.tick();
      }
      this.broadcastState();
    }, getConstant('NETCODE.PATCH_RATE_MS'));

    console.log(`[ArenaRoom] Created (max ${this.maxClients} players)`);
  }

  private async initializePhysics() {
    await initPhysics();
    this.world = createWorld();
    createArenaColliders(this.world);
    this.ballBody = createBall(this.world);
    createGoalSensors(this.world);
    this.physicsReady = true;
    console.log('[ArenaRoom] Physics initialized');
  }

  onJoin(client: colyseus.Client, options: any) {
    const player = new PlayerState();
    player.boost = getConstant('CAR.BOOST.START_AMOUNT');
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

    // Switch to 60Hz for physics
    this.setSimulationInterval(() => {
      if (this.physicsReady) {
        this.tick();
      }
      this.broadcastState();
    }, getConstant('PHYSICS.TIMESTEP') * 1000);

    console.log('[ArenaRoom] Match started at 60Hz');
  }

  private spawnCar(sessionId: string, team: string) {
    if (!this.physicsReady) {
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
      ? { x: 0, y: 1, z: 0, w: 0 }
      : { x: 0, y: 0, z: 0, w: 1 };

    const body = createCar(this.world, pos, rotation);
    this.carBodies.set(sessionId, { body, jumpState: createCarPhysicsState() });

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
    const y = carHeight / 2 + getConstant('ARENA.KICKOFF.SPAWN_CLEARANCE');

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

  private tick() {
    // 1. Apply car physics from player inputs (only during active play phases)
    if (this.state.phase === 'playing' || this.state.phase === 'overtime') {
      for (const [sessionId, carEntry] of this.carBodies) {
        const input = this.inputs.get(sessionId) || { throttle: 0, steer: 0, jump: false, boost: false };
        applyCarPhysics(this.world, carEntry.body, input, carEntry.jumpState);
      }
    }

    // 2. Step the Rapier world
    this.world.step();

    // 3. Sync physics state to schema (for internal tracking)
    this.syncBallState();
    this.syncPlayerStates();

    // 4. Check for goals
    if (this.state.phase === 'playing' || this.state.phase === 'overtime') {
      const scored = checkGoal(this.ballBody);
      if (scored) {
        if (scored === 'blue') this.state.blueScore++;
        else this.state.orangeScore++;

        if (this.state.phase === 'overtime') {
          this.wasOvertime = true;
        }

        this.state.phase = 'goal-scored';
        this.goalResetTimer = getGoalResetDelay();
        console.log(`[ArenaRoom] GOAL! ${scored} scores! (${this.state.blueScore}-${this.state.orangeScore})`);
      }
    }

    // 5. Update timer
    const timerState = {
      timeRemaining: this.state.timeRemaining,
      phase: this.state.phase,
      goalResetTimer: this.goalResetTimer,
    };
    const timerResult = updateTimer(timerState, getConstant('PHYSICS.TIMESTEP'));
    this.state.timeRemaining = timerState.timeRemaining;
    this.goalResetTimer = timerState.goalResetTimer;

    if (timerResult === 'time-up') {
      const result = resolveTimeUp(this.state.blueScore, this.state.orangeScore);
      if (result === 'overtime') {
        this.state.phase = 'overtime';
        this.state.timeRemaining = -1;
        this.wasOvertime = true;
        console.log('[ArenaRoom] OVERTIME! Next goal wins.');
      } else {
        this.state.phase = 'ended';
        console.log(`[ArenaRoom] Match ended! Blue ${this.state.blueScore} - ${this.state.orangeScore} Orange`);
      }
    } else if (timerResult === 'reset-complete') {
      const playerTeams = new Map<string, { team: string }>();
      for (const [sessionId, player] of this.state.players) {
        playerTeams.set(sessionId, { team: player.team });
      }
      resetToKickoff(this.ballBody, this.carBodies, playerTeams, this.getKickoffPosition.bind(this));

      if (this.wasOvertime) {
        this.state.phase = 'overtime';
      } else {
        this.state.phase = 'playing';
      }
      console.log(`[ArenaRoom] Kickoff reset. Resuming: ${this.state.phase}`);
    }
  }

  private broadcastState() {
    const players: Record<string, any> = {};
    this.state.players.forEach((p, k) => {
      players[k] = {
        x: p.x, y: p.y, z: p.z,
        qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw,
        vx: p.vx, vy: p.vy, vz: p.vz,
        boost: p.boost, team: p.team, name: p.name, isHost: p.isHost,
      };
    });

    const ball = this.state.ball;
    this.broadcast('state-sync', {
      players,
      ball: {
        x: ball.x, y: ball.y, z: ball.z,
        qx: ball.qx, qy: ball.qy, qz: ball.qz, qw: ball.qw,
        vx: ball.vx, vy: ball.vy, vz: ball.vz,
      },
      blueScore: this.state.blueScore,
      orangeScore: this.state.orangeScore,
      timeRemaining: this.state.timeRemaining,
      phase: this.state.phase,
    });
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
      player.boost = Math.round(carEntry.jumpState.boostAmount);
    }
  }

  getInput(sessionId: string): InputPayload {
    return this.inputs.get(sessionId) || { throttle: 0, steer: 0, jump: false, boost: false };
  }
}
