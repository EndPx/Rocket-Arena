import { Client, Room } from 'colyseus.js';

const SERVER_URL = `ws://${window.location.hostname}:2567`;

let client: Client;
let room: Room | null = null;

export function getClient(): Client {
  if (!client) {
    client = new Client(SERVER_URL);
  }
  return client;
}

export async function joinSandbox(name?: string): Promise<Room> {
  const c = getClient();
  room = await c.joinOrCreate('sandbox', { name: name || 'Player' });
  console.log(`[Net] Joined sandbox room: ${room.id}`);
  return room;
}

export async function joinArena(name?: string): Promise<Room> {
  const c = getClient();
  room = await c.joinOrCreate('arena', { name: name || 'Player' });
  console.log(`[Net] Joined arena room: ${room.id}`);
  return room;
}

export async function joinCustomRoom(code: string, name?: string): Promise<Room> {
  const c = getClient();
  room = await c.joinById(code, { name: name || 'Player' });
  console.log(`[Net] Joined custom room: ${room.id}`);
  return room;
}

export function getRoom(): Room | null {
  return room;
}
