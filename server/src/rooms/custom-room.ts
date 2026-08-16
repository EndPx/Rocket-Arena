import colyseus from 'colyseus';
import RAPIER from '@dimforge/rapier3d-compat';
import { GameState, PlayerState } from '@rocket-arena/shared/schema';
import { getConstant, setOverride, clearOverrides } from '@rocket-arena/shared/constants';
import type { InputPayload } from '@rocket-arena/shared/types';
import { initPhysics, createWorld } from '../physics/world.js';
import { createArenaColliders } from '../physics/arena.js';
import { createBall } from '../physics/ball.js';
import { createCar, applyCarPhysics } from '../physics/car.js';
import { createGoalSensors, checkGoal, resetToKickoff } from '../systems/scoring.js';
import { updateTimer, resolveTimeUp, getGoalResetDelay } from '../systems/match-timer.js';

const { Room } = colyseus;

interface CarEntry {
  body: RAPIER.RigidBody;
  jumpState: { count: number };
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes ambiguous: I,O,0,1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Custom Room — host creates, shares code, players join.
 * Host can start match at any time. Players can switch teams.
 */
export class CustomRoom extends Room<GameState> {
  private inputs: Map<string, InputPayload> = new Map();
  private countdownTimer: number = 0;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private world!: RAPIER.World;
  private ballBody!: RAPIER.RigidBody;
  private carBodies: Map<string, CarEntry> = new Map();
  private physicsReady: boolean = false;
  private goalResetTimer: number = 0;
  private wasOvertime: boolean = false;
  private hostSessionId: string = '';

  onCreate(options: any) {
    this.setState(new GameState());
    this.maxClients = 4;
    this.setPatchRate(getConstant('NETCODE.PATCH_RATE_MS'));

    // Generate room code and set metadata for room discovery
    const code = generateRoomCode();
    this.setMetadata({ code });

    // Handle input messages
    this.onMessage('input', (client, payload: InputPayload) => {
      this.inputs.set(client.sessionId, payload);
    });

    // Handle team switching
    this.onMessage('change-team', (client, data: { team: 'blue' | 'orange' }) => {
      // Only allow team switch during waiting/lobby phase
      if (this.state.phase !== 'waiting') return;

      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      if (data.team !== 'blue' && data.team !== 'orange') return;
      player.team = data.team;
      console.log(`[CustomRoom] ${player.name} switched to team ${data.team}`);
    });

    // Only host can start the match
    this.onMessage('start-match', (client) => {
      if (client.sessionId !== this.hostSessionId) {
        console.log(`[CustomRoom] Non-host ${client.sessionId} tried to start match`);
        return;
      }
      if (this.state.phase !== 'waiting') return;

      this.lock();
      this.startCountdown();
    });

    // Handle dev-tune messages
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

    // Initialize physics
    this.initializePhysics();

    console.log(`[CustomRoom] Created with code: ${code}`);
  }

  private async initializePhysics() {
    await initPhysics();
    this.world = createWorld();
    createArenaColliders(this.world);
    this.ballBody = createBall(this.world);
    createGoalSensors(this.world);
    this.physicsReady = true;

    console.log('[CustomRoom] Physics initialized');
  }

  onJoin(client: colyseus.Client, options: any) {
    const player = new PlayerState();
    player.name = options?.name || `Player ${this.clients.length}`;

    // First player to join is the host
    if (this.clients.length === 1) {
      this.hostSessionId = client.sessionId;
      player.isHost = true;
    }

    // Auto-assign team (balance teams)
    const blueCount = Array.from(this.state.players.values()).filter(p => p.team === 'blue').length;
    const orangeCount = Array.from(this.state.players.values()).filter(p => p.team === 'orange').length;
    player.team = blueCount <= orangeCount ? 'blue' : 'orange';

    this.state.players.set(client.sessionId, player);

    // Create car body at kickoff position
    this.spawnCar(client.sessionId, player.team);

    console.log(`[CustomRoom] ${player.name} joined team ${player.team} (host: ${player.isHost}) [${this.clients.length}/4]`);
  }

  onLeave(client: colyseus.Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(`[CustomRoom] ${player.name} left`);
    }
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.removeCar(client.sessionId);

    // If host leaves, reassign host to next player
    if (client.sessionId === this.hostSessionId) {
      const nextClient = this.clients.find(c => c.sessionId !== client.sessionId);
      if (nextClient) {
        this.hostSessionId = nextClient.sessionId;
        const nextPlayer = this.state.players.get(nextClient.sessionId);
        if (nextPlayer) {
          nextPlayer.isHost = true;
          console.log(`[CustomRoom] Host reassigned to ${nextPlayer.name}`);
        }
      }
    }
  }

  onDispose() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    if (this.world) {
      this.world.free();
    }
    console.log('[CustomRoom] Disposed');
  }

  private startCountdown() {
    this.state.phase = 'countdown';
    this.countdownTimer = getConstant('MATCH.COUNTDOWN_SECONDS');
    this.state.timeRemaining = this.countdownTimer;
    console.log(`[CustomRoom] Host started! Countdown: ${this.countdownTimer}s`);

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

    console.log('[CustomRoom] Match started! Physics loop running at 60Hz');
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
    this.carBodies.set(sessionId, { body, jumpState: { count: 0 } });

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
    if (this.state.phase === 'playing' || this.state.phase === 'overtime') {
      for (const [sessionId, carEntry] of this.carBodies) {
        const input = this.inputs.get(sessionId) || { throttle: 0, steer: 0, jump: false, boost: false };
        applyCarPhysics(this.world, carEntry.body, input, carEntry.jumpState);
      }
    }

    // 2. Step the Rapier world
    this.world.step();

    // 3. Sync physics state to Colyseus schema
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
        console.log(`[CustomRoom] GOAL! ${scored} scores! (${this.state.blueScore}-${this.state.orangeScore})`);
      }
    }

    // 5. Update timer
    const timerState = {
      timeRemaining: this.state.timeRemaining,
      phase: this.state.phase,
      goalResetTimer: this.goalResetTimer,
    };
    const timerResult = updateTimer(timerState, 1 / 60);
    this.state.timeRemaining = timerState.timeRemaining;
    this.goalResetTimer = timerState.goalResetTimer;

    if (timerResult === 'time-up') {
      const result = resolveTimeUp(this.state.blueScore, this.state.orangeScore);
      if (result === 'overtime') {
        this.state.phase = 'overtime';
        this.state.timeRemaining = -1;
        this.wasOvertime = true;
        console.log('[CustomRoom] OVERTIME! Next goal wins.');
      } else {
        this.state.phase = 'ended';
        console.log(`[CustomRoom] Match ended! Blue ${this.state.blueScore} - ${this.state.orangeScore} Orange`);
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
      console.log(`[CustomRoom] Kickoff reset. Resuming: ${this.state.phase}`);
    }
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
