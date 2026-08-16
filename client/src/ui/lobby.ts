import { joinArena, createCustomRoom, joinCustomRoom, getClient } from '../networking/client.js';
import { setupStateListener } from '../networking/state-listener.js';
import type { Room } from 'colyseus.js';
import * as THREE from 'three';

let lobbyEl: HTMLElement;
let onJoinCallback: ((room: Room) => void) | null = null;
let currentRoom: Room | null = null;
let scene: THREE.Scene | null = null;

export function createLobby(onJoin: (room: Room) => void, sceneRef: THREE.Scene): void {
  onJoinCallback = onJoin;
  scene = sceneRef;

  lobbyEl = document.createElement('div');
  lobbyEl.id = 'lobby';
  document.body.appendChild(lobbyEl);

  const style = document.createElement('style');
  style.textContent = getLobbyStyles();
  document.head.appendChild(style);

  showMainMenu();
}

// ============================================================
// Screen 1: Main Menu
// ============================================================

function showMainMenu(): void {
  lobbyEl.innerHTML = `
    <div class="lobby-card">
      <h1>Rocket Arena</h1>
      <input type="text" id="lobby-name" placeholder="Your name" maxlength="16" value="${getSavedName()}">
      <button id="lobby-quick" class="btn-primary">Quick Match</button>
      <button id="lobby-custom-toggle" class="btn-secondary">Custom Room</button>
      <p class="lobby-status" id="lobby-status"></p>
    </div>
  `;

  document.getElementById('lobby-quick')!.addEventListener('click', handleQuickMatch);
  document.getElementById('lobby-custom-toggle')!.addEventListener('click', showCustomScreen);
}

function showCustomScreen(): void {
  lobbyEl.innerHTML = `
    <div class="lobby-card">
      <h2>Custom Room</h2>
      <button id="lobby-create" class="btn-accent">Create Room</button>
      <div class="join-row">
        <input type="text" id="lobby-code" placeholder="Room code" maxlength="6">
        <button id="lobby-join-code" class="btn-accent">Join</button>
      </div>
      <button id="lobby-back" class="btn-danger">Back</button>
      <p class="lobby-status" id="lobby-status"></p>
    </div>
  `;

  document.getElementById('lobby-create')!.addEventListener('click', handleCreateRoom);
  document.getElementById('lobby-join-code')!.addEventListener('click', handleJoinByCode);
  document.getElementById('lobby-back')!.addEventListener('click', showMainMenu);
}

async function handleQuickMatch(): Promise<void> {
  const name = getPlayerName();
  const status = document.getElementById('lobby-status')!;
  status.textContent = 'Finding match...';

  try {
    const room = await joinArena(name);
    currentRoom = room;
    // Setup state listener immediately so we receive state-sync during lobby
    if (scene) setupStateListener(room, scene);
    showWaitingRoom(room);
  } catch (e: any) {
    status.textContent = `Error: ${e.message || 'Connection failed'}`;
  }
}

async function handleCreateRoom(): Promise<void> {
  const name = getPlayerName();
  const status = document.getElementById('lobby-status')!;
  status.textContent = 'Creating room...';

  try {
    const room = await createCustomRoom(name);
    currentRoom = room;
    // Setup state listener immediately so we receive state-sync during lobby
    if (scene) setupStateListener(room, scene);
    showCustomLobby(room);
  } catch (e: any) {
    status.textContent = `Error: ${e.message || 'Failed to create room'}`;
  }
}

async function handleJoinByCode(): Promise<void> {
  const code = (document.getElementById('lobby-code') as HTMLInputElement).value.trim().toUpperCase();
  const name = getPlayerName();
  const status = document.getElementById('lobby-status')!;

  if (!code) {
    status.textContent = 'Enter a room code';
    return;
  }

  status.textContent = 'Joining...';
  try {
    const room = await joinCustomRoom(code, name);
    currentRoom = room;
    // Setup state listener immediately so we receive state-sync during lobby
    if (scene) setupStateListener(room, scene);
    showCustomLobby(room);
  } catch (e: any) {
    status.textContent = `Error: ${e.message || 'Room not found'}`;
  }
}

// ============================================================
// Screen 2: Waiting Room (Quick Match)
// ============================================================

function showWaitingRoom(room: Room): void {
  lobbyEl.innerHTML = `
    <div class="lobby-card waiting-card">
      <h2>Quick Match</h2>
      <p class="waiting-text" id="waiting-text">Waiting for players...</p>
      <p class="player-count" id="player-count">1/4</p>
      <ul class="player-list" id="player-list"></ul>
      <button class="btn-danger" id="leave-room">Leave Room</button>
      <p class="lobby-status" id="lobby-status">Camera orbiting arena</p>
    </div>
  `;

  // Leave room handler
  document.getElementById('leave-room')!.addEventListener('click', () => {
    room.leave();
    currentRoom = null;
    showMainMenu();
  });

  let joined = false;

  // Listen for state-sync to update player list and detect phase transitions
  room.onMessage('state-sync', (data: any) => {
    updatePlayerList(data);

    if (data.phase === 'countdown') {
      const waitText = document.getElementById('waiting-text');
      if (waitText) waitText.textContent = 'Match starting...';
    }
    if ((data.phase === 'playing' || data.phase === 'overtime') && !joined) {
      joined = true;
      hideLobby();
      onJoinCallback?.(room);
    }
  });
}

function updatePlayerList(data: any): void {
  const listEl = document.getElementById('player-list');
  const countEl = document.getElementById('player-count');
  if (!listEl || !countEl || !data?.players) return;

  let html = '';
  let count = 0;
  for (const [, player] of Object.entries(data.players) as [string, any][]) {
    count++;
    const teamColor = player.team === 'blue' ? '#4488ff' : '#ff8844';
    html += `<li style="color:${teamColor}">${player.name} (${player.team})</li>`;
  }
  listEl.innerHTML = html;
  countEl.textContent = `${count}/4`;
}

// ============================================================
// Screen 3: Custom Room Lobby
// ============================================================

function showCustomLobby(room: Room): void {
  lobbyEl.innerHTML = `
    <div class="lobby-card custom-card">
      <h2>Custom Room</h2>
      <div class="room-code-display">
        <span class="room-code-label">Room Code:</span>
        <span class="room-code" id="room-code">Loading...</span>
      </div>
      <div class="teams-container">
        <div class="team-column blue-team">
          <h3>Blue Team</h3>
          <ul id="blue-list"></ul>
          <button class="btn-team btn-blue" id="join-blue">Join Blue</button>
        </div>
        <div class="team-column orange-team">
          <h3>Orange Team</h3>
          <ul id="orange-list"></ul>
          <button class="btn-team btn-orange" id="join-orange">Join Orange</button>
        </div>
      </div>
      <p class="player-count" id="player-count">1/4</p>
      <button class="btn-primary btn-start hidden" id="start-match">Start Match</button>
      <button class="btn-danger" id="leave-room">Leave Room</button>
      <p class="lobby-status" id="lobby-status"></p>
    </div>
  `;

  // Fetch room code from available rooms listing
  fetchRoomCode(room);

  // Team switch buttons
  document.getElementById('join-blue')!.addEventListener('click', () => {
    room.send('change-team', { team: 'blue' });
  });
  document.getElementById('join-orange')!.addEventListener('click', () => {
    room.send('change-team', { team: 'orange' });
  });

  // Start match button (host only)
  document.getElementById('start-match')!.addEventListener('click', () => {
    room.send('start-match');
  });

  // Leave room handler
  document.getElementById('leave-room')!.addEventListener('click', () => {
    room.leave();
    currentRoom = null;
    showMainMenu();
  });

  let joined = false;

  // Listen for state-sync to update team lists and detect phase transitions
  room.onMessage('state-sync', (data: any) => {
    updateTeamLists(data, room);

    const statusEl = document.getElementById('lobby-status');
    if (data.phase === 'countdown') {
      if (statusEl) statusEl.textContent = 'Match starting...';
    }
    if ((data.phase === 'playing' || data.phase === 'overtime') && !joined) {
      joined = true;
      hideLobby();
      onJoinCallback?.(room);
    }
  });
}

function updateTeamLists(data: any, room: Room): void {
  const blueList = document.getElementById('blue-list');
  const orangeList = document.getElementById('orange-list');
  const countEl = document.getElementById('player-count');
  const startBtn = document.getElementById('start-match');
  if (!blueList || !orangeList || !countEl || !startBtn || !data?.players) return;

  let blueHtml = '';
  let orangeHtml = '';
  let count = 0;
  let localIsHost = false;

  for (const [sessionId, player] of Object.entries(data.players) as [string, any][]) {
    count++;
    const isLocal = sessionId === room.sessionId;
    const hostBadge = player.isHost ? ' <span class="host-badge">HOST</span>' : '';
    const nameHtml = `<li class="${isLocal ? 'local-player' : ''}">${player.name}${hostBadge}</li>`;

    if (player.team === 'blue') {
      blueHtml += nameHtml;
    } else {
      orangeHtml += nameHtml;
    }

    if (isLocal && player.isHost) {
      localIsHost = true;
    }
  }

  blueList.innerHTML = blueHtml;
  orangeList.innerHTML = orangeHtml;
  countEl.textContent = `${count}/4`;

  // Show start button only for host
  if (localIsHost) {
    startBtn.classList.remove('hidden');
  } else {
    startBtn.classList.add('hidden');
  }
}

async function fetchRoomCode(room: Room): Promise<void> {
  try {
    const client = getClient();
    const rooms = await client.getAvailableRooms('custom');
    const thisRoom = rooms.find(r => r.roomId === room.id);
    const codeEl = document.getElementById('room-code');
    if (thisRoom && thisRoom.metadata?.code && codeEl) {
      codeEl.textContent = thisRoom.metadata.code;
    } else if (codeEl) {
      // Retry after a short delay (metadata may not be set yet)
      setTimeout(async () => {
        const retryRooms = await client.getAvailableRooms('custom');
        const retryRoom = retryRooms.find(r => r.roomId === room.id);
        if (retryRoom?.metadata?.code && codeEl) {
          codeEl.textContent = retryRoom.metadata.code;
        }
      }, 1000);
    }
  } catch (e) {
    console.warn('[Lobby] Could not fetch room code:', e);
  }
}

// ============================================================
// Utility
// ============================================================

function getPlayerName(): string {
  const input = document.getElementById('lobby-name') as HTMLInputElement | null;
  const name = input?.value?.trim() || 'Player';
  // Cache for next session
  localStorage.setItem('rocket-arena-name', name);
  return name;
}

function getSavedName(): string {
  return localStorage.getItem('rocket-arena-name') || 'Player';
}

export function hideLobby(): void {
  if (lobbyEl) lobbyEl.style.display = 'none';
}

export function showLobby(): void {
  if (lobbyEl) {
    lobbyEl.style.display = 'flex';
    showMainMenu();
  }
}

// ============================================================
// Styles
// ============================================================

function getLobbyStyles(): string {
  return `
    #lobby {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.85);
      z-index: 50;
      font-family: monospace;
    }
    .lobby-card {
      background: #1a1a2e;
      padding: 2rem;
      border-radius: 12px;
      text-align: center;
      min-width: 320px;
      max-width: 500px;
    }
    .lobby-card h1 { color: #fff; margin-bottom: 1.5rem; font-size: 1.8rem; }
    .lobby-card h2 { color: #fff; margin-bottom: 1rem; font-size: 1.4rem; }
    .lobby-card input {
      display: block; width: 100%; padding: 0.6rem;
      margin-bottom: 0.8rem; background: #222; color: #fff;
      border: 1px solid #444; border-radius: 4px;
      font-family: monospace; box-sizing: border-box;
    }
    .btn-primary {
      display: block; width: 100%; padding: 0.7rem;
      margin-bottom: 0.5rem; background: #3366ff; color: #fff;
      border: none; border-radius: 4px; font-weight: bold;
      cursor: pointer; font-family: monospace; font-size: 1rem;
    }
    .btn-primary:hover { background: #4477ff; }
    .btn-secondary {
      display: block; width: 100%; padding: 0.7rem;
      margin-bottom: 0.5rem; background: #555; color: #fff;
      border: none; border-radius: 4px; font-weight: bold;
      cursor: pointer; font-family: monospace; font-size: 1rem;
    }
    .btn-secondary:hover { background: #666; }
    .btn-danger {
      display: block; width: 100%; padding: 0.7rem;
      margin-bottom: 0.5rem; background: #cc3333; color: #fff;
      border: none; border-radius: 4px; font-weight: bold;
      cursor: pointer; font-family: monospace; font-size: 1rem;
    }
    .btn-danger:hover { background: #dd4444; }
    .btn-accent {
      display: block; width: 100%; padding: 0.6rem;
      margin-bottom: 0.5rem; background: #2a9d8f; color: #fff;
      border: none; border-radius: 4px; font-weight: bold;
      cursor: pointer; font-family: monospace; font-size: 0.9rem;
    }
    .btn-accent:hover { background: #3ab8a8; }
    .custom-options { margin-top: 0.5rem; }
    .custom-options.hidden { display: none; }
    .join-row { display: flex; gap: 0.5rem; }
    .join-row input { flex: 1; margin-bottom: 0; }
    .join-row button { width: auto; margin-bottom: 0; padding: 0.6rem 1rem; }
    .lobby-status { color: #aaa; font-size: 0.8rem; margin-top: 1rem; min-height: 1.2rem; }

    /* Waiting Room */
    .waiting-text { color: #ccc; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .player-count { color: #ffcc00; font-size: 1.3rem; font-weight: bold; margin-bottom: 0.5rem; }
    .player-list {
      list-style: none; padding: 0; margin: 0.5rem 0;
      text-align: left;
    }
    .player-list li { padding: 0.3rem 0.5rem; border-bottom: 1px solid #333; }

    /* Custom Room */
    .room-code-display { margin-bottom: 1rem; }
    .room-code-label { color: #aaa; font-size: 0.9rem; }
    .room-code {
      display: block; font-size: 2rem; font-weight: bold;
      color: #ffcc00; letter-spacing: 4px; margin-top: 0.3rem;
    }
    .teams-container { display: flex; gap: 1rem; margin-bottom: 1rem; }
    .team-column {
      flex: 1; padding: 0.8rem; border-radius: 8px;
      min-height: 100px;
    }
    .blue-team { background: rgba(68, 136, 255, 0.15); border: 1px solid #4488ff; }
    .orange-team { background: rgba(255, 136, 68, 0.15); border: 1px solid #ff8844; }
    .team-column h3 { color: #fff; font-size: 0.9rem; margin-bottom: 0.5rem; }
    .team-column ul { list-style: none; padding: 0; margin: 0; text-align: left; }
    .team-column ul li { color: #ddd; padding: 0.2rem 0; font-size: 0.85rem; }
    .team-column ul li.local-player { color: #fff; font-weight: bold; }
    .host-badge {
      background: #ffcc00; color: #000; font-size: 0.65rem;
      padding: 0.1rem 0.3rem; border-radius: 3px; margin-left: 0.3rem;
      font-weight: bold;
    }
    .btn-team {
      width: 100%; padding: 0.4rem; margin-top: 0.5rem;
      border: none; border-radius: 4px; cursor: pointer;
      font-family: monospace; font-size: 0.8rem; font-weight: bold;
    }
    .btn-blue { background: #4488ff; color: #fff; }
    .btn-blue:hover { background: #5599ff; }
    .btn-orange { background: #ff8844; color: #fff; }
    .btn-orange:hover { background: #ff9955; }
    .btn-start { margin-top: 1rem; }
    .btn-start.hidden { display: none; }
  `;
}
