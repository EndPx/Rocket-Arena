import { Client, Room } from 'colyseus.js';
import { GameState } from '@rocket-arena/shared';

const SERVER_URL = `ws://${window.location.hostname}:2567`;

let client: Client;
let room: Room<GameState> | null = null;

type DebugWindow = Window & { __debugRoom?: Room<GameState> | null };

function exposeDebugRoom(nextRoom: Room<GameState> | null): void {
  (window as DebugWindow).__debugRoom = nextRoom;
}

function clearCurrentRoom(expectedRoom: Room<GameState>): void {
  if (room !== expectedRoom) return;
  room = null;
  exposeDebugRoom(null);
}

function ownRoom(nextRoom: Room<GameState>): Room<GameState> {
  room = nextRoom;
  exposeDebugRoom(nextRoom);
  nextRoom.onLeave(() => clearCurrentRoom(nextRoom));
  return nextRoom;
}

export function getClient(): Client {
  if (!client) {
    client = new Client(SERVER_URL);
  }
  return client;
}

export async function joinArena(name?: string): Promise<Room<GameState>> {
  const c = getClient();
  const joinedRoom = ownRoom(
    await c.joinOrCreate<GameState>('arena', { name: name || 'Player' }),
  );
  console.log(`[Net] Joined arena room: ${joinedRoom.id}, sessionId: ${joinedRoom.sessionId}`);
  return joinedRoom;
}

export async function createCustomRoom(name?: string): Promise<Room<GameState>> {
  const c = getClient();
  const joinedRoom = ownRoom(await c.create<GameState>('custom', { name: name || 'Player' }));
  console.log(`[Net] Created custom room: ${joinedRoom.id}`);
  return joinedRoom;
}

export async function joinCustomRoom(code: string, name?: string): Promise<Room<GameState>> {
  const c = getClient();
  // Find room by metadata code
  const rooms = await c.getAvailableRooms('custom');
  const target = rooms.find(r => r.metadata?.code === code.toUpperCase());
  if (!target) throw new Error('Room not found');
  const joinedRoom = ownRoom(
    await c.joinById<GameState>(target.roomId, { name: name || 'Player' }),
  );
  console.log(`[Net] Joined custom room: ${joinedRoom.id} (code: ${code})`);
  return joinedRoom;
}

export function getRoom(): Room<GameState> | null {
  if (room && !room.connection.isOpen) clearCurrentRoom(room);
  return room;
}
