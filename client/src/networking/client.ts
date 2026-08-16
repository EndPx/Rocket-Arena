import { Client, Room } from 'colyseus.js';
import { GameState } from '@rocket-arena/shared';

const SERVER_URL = `ws://${window.location.hostname}:2567`;

let client: Client;
let room: Room<GameState> | null = null;

export function getClient(): Client {
  if (!client) {
    client = new Client(SERVER_URL);
  }
  return client;
}

export async function joinSandbox(name?: string): Promise<Room<GameState>> {
  const c = getClient();
  room = await c.joinOrCreate<GameState>('sandbox', { name: name || 'Player' });
  (window as any).__debugRoom = room;
  console.log(`[Net] Joined sandbox room: ${room.id}, sessionId: ${room.sessionId}`);
  return room;
}

export async function joinArena(name?: string): Promise<Room<GameState>> {
  const c = getClient();
  room = await c.joinOrCreate<GameState>('arena', { name: name || 'Player' });
  (window as any).__debugRoom = room;
  console.log(`[Net] Joined arena room: ${room.id}, sessionId: ${room.sessionId}`);
  return room;
}

export async function joinCustomRoom(code: string, name?: string): Promise<Room<GameState>> {
  const c = getClient();
  room = await c.joinById<GameState>(code, { name: name || 'Player' });
  (window as any).__debugRoom = room;
  console.log(`[Net] Joined custom room: ${room.id}`);
  return room;
}

export function getRoom(): Room<GameState> | null {
  return room;
}
