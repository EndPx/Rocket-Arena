import { Client, type Room } from 'colyseus.js';
import { GameState, type RoomMode } from '@rocket-arena/shared';

type GameRoom = Room<GameState>;
type RoomObserver = (room: GameRoom | null) => void;
type DebugWindow = Window & { __debugRoom?: GameRoom | null };

/** Owns one client connection's room identity and explicit decode mode. */
export class RoomConnectionManager {
  private room: GameRoom | null = null;
  private readonly joinedRoomModes = new WeakMap<GameRoom, RoomMode>();

  constructor(
    readonly client: Client,
    private readonly observeRoom: RoomObserver = () => {},
  ) {}

  async joinArena(name?: string): Promise<GameRoom> {
    const joinedRoom = this.ownRoom(
      await this.client.joinOrCreate<GameState>('arena', { name: name || 'Player' }),
      'quick',
    );
    console.log(`[Net] Joined arena room: ${joinedRoom.id}, sessionId: ${joinedRoom.sessionId}`);
    return joinedRoom;
  }

  async createCustomRoom(name?: string): Promise<GameRoom> {
    const joinedRoom = this.ownRoom(
      await this.client.create<GameState>('custom', { name: name || 'Player' }),
      'custom',
    );
    console.log(`[Net] Created custom room: ${joinedRoom.id}`);
    return joinedRoom;
  }

  async joinCustomRoom(code: string, name?: string): Promise<GameRoom> {
    const rooms = await this.client.getAvailableRooms('custom');
    const target = rooms.find((candidate) => candidate.metadata?.code === code.toUpperCase());
    if (!target) throw new Error('Room not found');
    const joinedRoom = this.ownRoom(
      await this.client.joinById<GameState>(target.roomId, { name: name || 'Player' }),
      'custom',
    );
    console.log(`[Net] Joined custom room: ${joinedRoom.id} (code: ${code})`);
    return joinedRoom;
  }

  getJoinedRoomMode(joinedRoom: GameRoom): RoomMode {
    const mode = this.joinedRoomModes.get(joinedRoom);
    if (mode === undefined) {
      throw new Error('Joined room mode is unavailable for this connection.');
    }
    return mode;
  }

  getRoom(): GameRoom | null {
    if (this.room && !this.room.connection.isOpen) this.clearCurrentRoom(this.room);
    return this.room;
  }

  private ownRoom(nextRoom: GameRoom, mode: RoomMode): GameRoom {
    this.room = nextRoom;
    this.joinedRoomModes.set(nextRoom, mode);
    this.observeRoom(nextRoom);
    nextRoom.onLeave(() => this.clearCurrentRoom(nextRoom));
    return nextRoom;
  }

  private clearCurrentRoom(expectedRoom: GameRoom): void {
    this.joinedRoomModes.delete(expectedRoom);
    if (this.room !== expectedRoom) return;
    this.room = null;
    this.observeRoom(null);
  }
}

let client: Client | null = null;
let connectionManager: RoomConnectionManager | null = null;

function exposeDebugRoom(nextRoom: GameRoom | null): void {
  if (typeof window === 'undefined') return;
  (window as DebugWindow).__debugRoom = nextRoom;
}

function getServerUrl(): string {
  if (typeof window === 'undefined') {
    throw new Error('The browser networking client requires a Window location.');
  }
  return `ws://${window.location.hostname}:2567`;
}

export function getClient(): Client {
  if (client === null) client = new Client(getServerUrl());
  return client;
}

function getConnectionManager(): RoomConnectionManager {
  if (connectionManager === null) {
    connectionManager = new RoomConnectionManager(getClient(), exposeDebugRoom);
  }
  return connectionManager;
}

export function joinArena(name?: string): Promise<GameRoom> {
  return getConnectionManager().joinArena(name);
}

export function createCustomRoom(name?: string): Promise<GameRoom> {
  return getConnectionManager().createCustomRoom(name);
}

export function joinCustomRoom(code: string, name?: string): Promise<GameRoom> {
  return getConnectionManager().joinCustomRoom(code, name);
}

export function getJoinedRoomMode(joinedRoom: GameRoom): RoomMode {
  return getConnectionManager().getJoinedRoomMode(joinedRoom);
}

export function getRoom(): GameRoom | null {
  return getConnectionManager().getRoom();
}
