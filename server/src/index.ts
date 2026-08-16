import colyseus from 'colyseus';
import wsTransport from '@colyseus/ws-transport';
import http from 'http';
import { ArenaRoom } from './rooms/arena-room.js';
import { SandboxRoom } from './rooms/sandbox-room.js';

const { Server } = colyseus;
const { WebSocketTransport } = wsTransport;

const PORT = Number(process.env.PORT) || 2567;

async function main() {
  const server = http.createServer();

  const gameServer = new Server({
    transport: new WebSocketTransport({ server }),
  });

  // Register room types
  gameServer.define('arena', ArenaRoom);
  gameServer.define('sandbox', SandboxRoom);

  gameServer.listen(PORT);
  console.log(`[Rocket Arena] Server listening on ws://localhost:${PORT}`);
  console.log(`[Rocket Arena] Rooms: arena (2v2), sandbox (dev)`);
}

main().catch(console.error);
