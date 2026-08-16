import * as THREE from 'three';
import type { Room } from 'colyseus.js';
import { createCarMesh } from '../renderer/car.js';
import { createBallMesh } from '../renderer/ball.js';

const carMeshes: Map<string, THREE.Group> = new Map();
let ballMesh: THREE.Group | null = null;
let localState: StateSync | null = null;

export interface StateSync {
  players: Record<string, {
    x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
    vx: number; vy: number; vz: number;
    boost: number; team: string; name: string; isHost: boolean;
  }>;
  ball: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; vx: number; vy: number; vz: number };
  blueScore: number;
  orangeScore: number;
  timeRemaining: number;
  phase: string;
}

/**
 * Set up a single onMessage('state-sync') listener.
 * Replaces all Schema-based callbacks with manual broadcast sync.
 */
export function setupStateListener(room: Room, scene: THREE.Scene): void {
  // Create ball mesh
  ballMesh = createBallMesh();
  scene.add(ballMesh);

  // Listen for manual state-sync broadcasts from server
  room.onMessage('state-sync', (data: StateSync) => {
    localState = data;

    // Update ball position
    if (ballMesh && data.ball) {
      ballMesh.position.set(data.ball.x, data.ball.y, data.ball.z);
      ballMesh.quaternion.set(data.ball.qx, data.ball.qy, data.ball.qz, data.ball.qw);
    }

    // Track which player IDs exist in this update
    const currentIds = new Set(Object.keys(data.players));

    // Add new cars or update existing ones
    for (const [sessionId, player] of Object.entries(data.players)) {
      if (!carMeshes.has(sessionId)) {
        const carMesh = createCarMesh(player.team);
        scene.add(carMesh);
        carMeshes.set(sessionId, carMesh);
        console.log(`[State] Car added: ${sessionId} (${player.team})`);
      }

      const mesh = carMeshes.get(sessionId)!;
      mesh.position.set(player.x, player.y, player.z);
      mesh.quaternion.set(player.qx, player.qy, player.qz, player.qw);
    }

    // Remove cars that are no longer in state
    for (const [sessionId, mesh] of carMeshes) {
      if (!currentIds.has(sessionId)) {
        scene.remove(mesh);
        carMeshes.delete(sessionId);
        console.log(`[State] Car removed: ${sessionId}`);
      }
    }
  });

  console.log('[State] Listener setup complete (using broadcast sync)');
}

export function getCarMeshes(): ReadonlyMap<string, THREE.Group> {
  return carMeshes;
}

export function getBallMesh(): THREE.Group | null {
  return ballMesh;
}

/** Get the latest state snapshot for HUD and lobby UI */
export function getLocalState(): StateSync | null {
  return localState;
}
