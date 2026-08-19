import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client, Room } from 'colyseus.js';
import type { GameState } from '@rocket-arena/shared';
import { RoomConnectionManager } from '../src/networking/client.js';

type LeaveHandler = () => void;

class FakeRoom {
  readonly connection = { isOpen: true };
  private readonly leaveHandlers: LeaveHandler[] = [];

  constructor(
    readonly id: string,
    readonly sessionId: string,
  ) {}

  onLeave(handler: LeaveHandler): void {
    this.leaveHandlers.push(handler);
  }

  leave(): void {
    this.connection.isOpen = false;
    for (const handler of this.leaveHandlers) handler();
  }
}

class FakeClient {
  readonly calls: Array<readonly [string, ...unknown[]]> = [];
  readonly arena = new FakeRoom('arena-id', 'quick-session');
  readonly createdCustom = new FakeRoom('created-custom-id', 'custom-host');
  readonly joinedCustom = new FakeRoom('listed-custom-id', 'custom-guest');

  async joinOrCreate(roomName: string, options: unknown): Promise<FakeRoom> {
    this.calls.push(['joinOrCreate', roomName, options]);
    return this.arena;
  }

  async create(roomName: string, options: unknown): Promise<FakeRoom> {
    this.calls.push(['create', roomName, options]);
    return this.createdCustom;
  }

  async getAvailableRooms(roomName: string): Promise<readonly unknown[]> {
    this.calls.push(['getAvailableRooms', roomName]);
    return [{ roomId: this.joinedCustom.id, metadata: { code: 'ABC234' } }];
  }

  async joinById(roomId: string, options: unknown): Promise<FakeRoom> {
    this.calls.push(['joinById', roomId, options]);
    return this.joinedCustom;
  }
}

function asClient(value: FakeClient): Client {
  return value as unknown as Client;
}

function asRoom(value: FakeRoom): Room<GameState> {
  return value as unknown as Room<GameState>;
}

// Validates: Requirements 6.2-6.12

test('Quick, create-Custom, and join-Custom retain explicit connection-owned modes', async () => {
  const fakeClient = new FakeClient();
  const observed: Array<Room<GameState> | null> = [];
  const manager = new RoomConnectionManager(
    asClient(fakeClient),
    (room) => { observed.push(room); },
  );

  const quick = await manager.joinArena('Quick Driver');
  assert.strictEqual(quick, asRoom(fakeClient.arena));
  assert.equal(manager.getJoinedRoomMode(quick), 'quick');
  assert.deepEqual(fakeClient.calls[0], [
    'joinOrCreate',
    'arena',
    { name: 'Quick Driver' },
  ]);

  const created = await manager.createCustomRoom('Host Driver');
  assert.strictEqual(created, asRoom(fakeClient.createdCustom));
  assert.equal(manager.getJoinedRoomMode(created), 'custom');
  assert.deepEqual(fakeClient.calls[1], [
    'create',
    'custom',
    { name: 'Host Driver' },
  ]);

  fakeClient.arena.leave();
  assert.strictEqual(manager.getRoom(), created, 'a stale leave cannot clear the newer room');
  assert.throws(() => manager.getJoinedRoomMode(quick), /mode is unavailable/);

  const joined = await manager.joinCustomRoom('abc234', 'Guest Driver');
  assert.strictEqual(joined, asRoom(fakeClient.joinedCustom));
  assert.equal(manager.getJoinedRoomMode(joined), 'custom');
  assert.deepEqual(fakeClient.calls.slice(2), [
    ['getAvailableRooms', 'custom'],
    ['joinById', 'listed-custom-id', { name: 'Guest Driver' }],
  ]);
  assert.deepEqual(observed, [quick, created, joined]);

  fakeClient.joinedCustom.leave();
  assert.equal(manager.getRoom(), null);
  assert.throws(() => manager.getJoinedRoomMode(joined), /mode is unavailable/);
  assert.deepEqual(observed, [quick, created, joined, null]);
});

test('unknown Custom codes fail without claiming a room or mode', async () => {
  const fakeClient = new FakeClient();
  fakeClient.getAvailableRooms = async (roomName: string) => {
    fakeClient.calls.push(['getAvailableRooms', roomName]);
    return [];
  };
  const manager = new RoomConnectionManager(asClient(fakeClient));

  await assert.rejects(() => manager.joinCustomRoom('ZZZ999'), /Room not found/);
  assert.equal(manager.getRoom(), null);
  assert.deepEqual(fakeClient.calls, [['getAvailableRooms', 'custom']]);
});
