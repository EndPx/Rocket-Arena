import colyseus from 'colyseus';
import wsTransport from '@colyseus/ws-transport';
import http from 'http';
import { ArenaRoom } from './rooms/arena-room.js';
import { CustomRoom } from './rooms/custom-room.js';

const { Server } = colyseus;
const { WebSocketTransport } = wsTransport;

const PORT = Number(process.env.PORT) || 2567;

async function main() {
  const server = http.createServer();

  const gameServer = new Server({
    transport: new WebSocketTransport({ server }),
  });

  gameServer.define('arena', ArenaRoom);       // Quick Match
  gameServer.define('custom', CustomRoom);     // Custom Room

  gameServer.listen(PORT);
  console.log(`[Rocket Arena] Server listening on ws://localhost:${PORT}`);
  console.log(`[Rocket Arena] Rooms: arena (quick match), custom (custom room)`);
}

main().catch(console.error);
