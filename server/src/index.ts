import colyseus from 'colyseus';
import wsTransport from '@colyseus/ws-transport';
import http from 'http';
import { ArenaRoom } from './rooms/arena-room.js';
import { CustomRoom } from './rooms/custom-room.js';

const { Server } = colyseus;
const { WebSocketTransport } = wsTransport;

const PORT = Number(process.env.PORT) || 2567;

/**
 * Loopback by default so a deployment cannot accidentally publish the raw,
 * un-TLS'd game port. Set HOST=0.0.0.0 to bind every interface on purpose.
 */
const HOST = process.env.HOST ?? '127.0.0.1';

async function main() {
  const server = http.createServer();

  const gameServer = new Server({
    transport: new WebSocketTransport({ server }),
  });

  gameServer.define('arena', ArenaRoom);       // Quick Match
  gameServer.define('custom', CustomRoom);     // Custom Room

  gameServer.listen(PORT, HOST);
  console.log(`[Rocket Arena] Server listening on ws://${HOST}:${PORT}`);
  console.log(`[Rocket Arena] Rooms: arena (quick match), custom (custom room)`);
}

main().catch(console.error);
