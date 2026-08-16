import { joinSandbox, joinArena, getClient } from '../networking/client.js';
import type { Room } from 'colyseus.js';

let lobbyEl: HTMLElement;
let onJoinCallback: ((room: Room) => void) | null = null;

export function createLobby(onJoin: (room: Room) => void): void {
  onJoinCallback = onJoin;

  lobbyEl = document.createElement('div');
  lobbyEl.id = 'lobby';
  lobbyEl.innerHTML = `
    <div class="lobby-card">
      <h1>Rocket Arena</h1>
      <input type="text" id="lobby-name" placeholder="Your name" maxlength="16" value="Player">
      <button id="lobby-quick">Quick Match</button>
      <button id="lobby-sandbox">Sandbox (Dev)</button>
      <div class="lobby-custom">
        <input type="text" id="lobby-code" placeholder="Room code" maxlength="6">
        <button id="lobby-join-code">Join</button>
      </div>
      <p class="lobby-status" id="lobby-status"></p>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #lobby { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); z-index: 50; font-family: monospace; }
    .lobby-card { background: #1a1a2e; padding: 2rem; border-radius: 12px; text-align: center; min-width: 300px; }
    .lobby-card h1 { color: #fff; margin-bottom: 1.5rem; font-size: 1.8rem; }
    .lobby-card input { display: block; width: 100%; padding: 0.6rem; margin-bottom: 0.8rem; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; font-family: monospace; box-sizing: border-box; }
    .lobby-card button { display: block; width: 100%; padding: 0.7rem; margin-bottom: 0.5rem; background: #3366ff; color: #fff; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; font-family: monospace; font-size: 1rem; }
    .lobby-card button:hover { background: #4477ff; }
    #lobby-sandbox { background: #555; }
    #lobby-sandbox:hover { background: #666; }
    .lobby-custom { display: flex; gap: 0.5rem; }
    .lobby-custom input { flex: 1; margin-bottom: 0; }
    .lobby-custom button { width: auto; margin-bottom: 0; padding: 0.6rem 1rem; }
    .lobby-status { color: #aaa; font-size: 0.8rem; margin-top: 1rem; min-height: 1.2rem; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(lobbyEl);

  // Event handlers
  document.getElementById('lobby-quick')!.addEventListener('click', () => handleJoin('arena'));
  document.getElementById('lobby-sandbox')!.addEventListener('click', () => handleJoin('sandbox'));
  document.getElementById('lobby-join-code')!.addEventListener('click', () => handleJoinByCode());
}

async function handleJoin(type: 'arena' | 'sandbox') {
  const name = (document.getElementById('lobby-name') as HTMLInputElement).value || 'Player';
  const status = document.getElementById('lobby-status')!;
  status.textContent = 'Connecting...';

  try {
    let room: Room;
    if (type === 'sandbox') {
      room = await joinSandbox(name);
    } else {
      room = await joinArena(name);
    }
    status.textContent = `Joined! Room: ${room.id}`;
    hideLobby();
    onJoinCallback?.(room);
  } catch (e: any) {
    status.textContent = `Error: ${e.message || 'Connection failed'}`;
  }
}

async function handleJoinByCode() {
  const code = (document.getElementById('lobby-code') as HTMLInputElement).value.trim();
  const name = (document.getElementById('lobby-name') as HTMLInputElement).value || 'Player';
  const status = document.getElementById('lobby-status')!;

  if (!code) {
    status.textContent = 'Enter a room code';
    return;
  }

  status.textContent = 'Joining...';
  try {
    const client = getClient();
    const room = await client.joinById(code, { name });
    status.textContent = `Joined room ${code}!`;
    hideLobby();
    onJoinCallback?.(room);
  } catch (e: any) {
    status.textContent = `Error: ${e.message || 'Room not found'}`;
  }
}

export function hideLobby(): void {
  if (lobbyEl) lobbyEl.style.display = 'none';
}

export function showLobby(): void {
  if (lobbyEl) lobbyEl.style.display = 'flex';
}
