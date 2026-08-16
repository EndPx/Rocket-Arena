import colyseus from 'colyseus';
import wsTransport from '@colyseus/ws-transport';
import http from 'http';

const { Server } = colyseus;
const { WebSocketTransport } = wsTransport;

const PORT = Number(process.env.PORT) || 2567;

async function main() {
  const server = http.createServer();

  const gameServer = new Server({
    transport: new WebSocketTransport({ server }),
  });

  // Room definitions will be registered here in Task 7
  // gameServer.define('arena', ArenaRoom);
  // gameServer.define('sandbox', SandboxRoom);

  gameServer.listen(PORT);
  console.log(`[Rocket Arena] Server listening on ws://localhost:${PORT}`);
}

main().catch(console.error);
