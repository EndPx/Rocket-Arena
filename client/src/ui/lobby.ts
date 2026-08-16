import { joinArena, createCustomRoom, joinCustomRoom, getClient } from '../networking/client.js';
import { setupStateListener } from '../networking/state-listener.js';
import type { Room } from 'colyseus.js';
import * as THREE from 'three';
import logoUrl from '../assets/generated/rocket-arena-logo.png';
import markUrl from '../assets/generated/rocket-arena-mark.png';
import {
  isCompleteRoomCode,
  normalizePlayerName,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
} from './lobby-input.js';

const PLAYER_NAME_STORAGE_KEY = 'rocket-arena-name';

let lobbyEl: HTMLElement;
let onJoinCallback: ((room: Room) => void) | null = null;
let currentRoom: Room | null = null;
let scene: THREE.Scene | null = null;
let currentPlayerName = 'Player';

export function createLobby(onJoin: (room: Room) => void, sceneRef: THREE.Scene): void {
  onJoinCallback = onJoin;
  scene = sceneRef;
  currentPlayerName = getSavedName();

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
      <h1 class="lobby-brand">
        <img
          class="lobby-brand-wide"
          src="${logoUrl}"
          alt="Rocket Arena"
          width="1024"
          height="410"
          draggable="false"
        >
        <span class="lobby-brand-compact">
          <img
            class="lobby-brand-mark"
            src="${markUrl}"
            alt=""
            width="512"
            height="512"
            draggable="false"
          >
          <span class="lobby-brand-name">
            <span>ROCKET</span>
            <span class="lobby-brand-arena">ARENA</span>
          </span>
        </span>
      </h1>
      <div class="lobby-action-stack" id="lobby-main-actions">
        <label class="sr-only" for="lobby-name">Player name</label>
        <input
          type="text"
          id="lobby-name"
          placeholder="Your name"
          maxlength="16"
          autocomplete="nickname"
          aria-describedby="lobby-status"
        >
        <button id="lobby-quick" class="btn-primary" type="button">Quick Match</button>
        <button id="lobby-custom-toggle" class="btn-secondary" type="button">Custom Room</button>
      </div>
      <p class="lobby-status" id="lobby-status" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
  `;

  const nameInput = document.getElementById('lobby-name') as HTMLInputElement;
  nameInput.value = currentPlayerName;

  document.getElementById('lobby-quick')!.addEventListener('click', handleQuickMatch);
  document.getElementById('lobby-custom-toggle')!.addEventListener('click', () => {
    getPlayerName();
    showCustomScreen();
  });
}

// ============================================================
// Screen 2: Custom Room Selection
// ============================================================

function showCustomScreen(): void {
  lobbyEl.innerHTML = `
    <div class="lobby-card">
      <h2>Custom Room</h2>
      <div class="lobby-action-stack" id="lobby-custom-actions">
        <button id="lobby-create" class="btn-accent" type="button">Create Room</button>
        <button id="lobby-open-code" class="btn-accent" type="button">Join Code</button>
        <button id="lobby-back" class="btn-danger" type="button">Back</button>
      </div>
      <p class="lobby-status" id="lobby-status" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
  `;

  document.getElementById('lobby-create')!.addEventListener('click', handleCreateRoom);
  document.getElementById('lobby-open-code')!.addEventListener('click', showJoinCodeScreen);
  document.getElementById('lobby-back')!.addEventListener('click', showMainMenu);
}

// ============================================================
// Screen 3: Join Custom Room
// ============================================================

function showJoinCodeScreen(): void {
  lobbyEl.innerHTML = `
    <div class="lobby-card">
      <h2>Join Custom Room</h2>
      <form class="lobby-action-stack" id="lobby-code-form" novalidate>
        <label class="lobby-field-label" for="lobby-code">Room code</label>
        <input
          class="room-code-input"
          type="text"
          id="lobby-code"
          name="roomCode"
          placeholder="ABC234"
          maxlength="6"
          minlength="6"
          pattern="[${ROOM_CODE_ALPHABET}]{6}"
          inputmode="text"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="lobby-status"
        >
        <button id="lobby-join-code" class="btn-accent" type="submit">Join</button>
        <button id="lobby-code-back" class="btn-danger" type="button">Back</button>
      </form>
      <p class="lobby-status" id="lobby-status" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
  `;

  const codeInput = document.getElementById('lobby-code') as HTMLInputElement;
  const form = document.getElementById('lobby-code-form') as HTMLFormElement;

  codeInput.addEventListener('input', () => {
    codeInput.value = normalizeRoomCode(codeInput.value);
    codeInput.removeAttribute('aria-invalid');
    setStatus(document.getElementById('lobby-status')!, '');
  });
  form.addEventListener('submit', handleJoinByCode);
  document.getElementById('lobby-code-back')!.addEventListener('click', showCustomScreen);
  codeInput.focus();
}

async function handleQuickMatch(): Promise<void> {
  const button = document.getElementById('lobby-quick') as HTMLButtonElement;
  if (button.disabled) return;

  const name = getPlayerName();
  const status = document.getElementById('lobby-status')!;
  const actions = document.getElementById('lobby-main-actions')!;
  setStatus(status, 'Finding match...');
  setActionPending(actions, button, true, 'Finding...');

  try {
    const room = await joinArena(name);
    currentRoom = room;
    // Setup state listener immediately so we receive state-sync during lobby
    if (scene) setupStateListener(room, scene);
    showWaitingRoom(room);
  } catch (error: unknown) {
    setStatus(status, `Error: ${getErrorMessage(error, 'Connection failed')}`, true);
  } finally {
    setActionPending(actions, button, false, '');
  }
}

async function handleCreateRoom(): Promise<void> {
  const button = document.getElementById('lobby-create') as HTMLButtonElement;
  if (button.disabled) return;

  const name = getPlayerName();
  const status = document.getElementById('lobby-status')!;
  const actions = document.getElementById('lobby-custom-actions')!;
  setStatus(status, 'Creating room...');
  setActionPending(actions, button, true, 'Creating...');

  try {
    const room = await createCustomRoom(name);
    currentRoom = room;
    // Setup state listener immediately so we receive state-sync during lobby
    if (scene) setupStateListener(room, scene);
    showCustomLobby(room);
  } catch (error: unknown) {
    setStatus(status, `Error: ${getErrorMessage(error, 'Failed to create room')}`, true);
  } finally {
    setActionPending(actions, button, false, '');
  }
}

async function handleJoinByCode(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  const form = document.getElementById('lobby-code-form') as HTMLFormElement;
  const input = document.getElementById('lobby-code') as HTMLInputElement;
  const button = document.getElementById('lobby-join-code') as HTMLButtonElement;
  const status = document.getElementById('lobby-status')!;
  if (button.disabled) return;

  const code = normalizeRoomCode(input.value);
  input.value = code;

  if (!isCompleteRoomCode(code)) {
    input.setAttribute('aria-invalid', 'true');
    setStatus(status, 'Enter a complete 6-character room code.', true);
    input.focus();
    return;
  }

  input.removeAttribute('aria-invalid');
  setStatus(status, 'Joining...');
  setActionPending(form, button, true, 'Joining...');

  try {
    const room = await joinCustomRoom(code, getPlayerName());
    currentRoom = room;
    // Setup state listener immediately so we receive state-sync during lobby
    if (scene) setupStateListener(room, scene);
    showCustomLobby(room);
  } catch (error: unknown) {
    setStatus(status, `Error: ${getErrorMessage(error, 'Room not found')}`, true);
  } finally {
    setActionPending(form, button, false, '');
  }
}

// ============================================================
// Screen 4: Waiting Room (Quick Match)
// ============================================================

function showWaitingRoom(room: Room): void {
  lobbyEl.innerHTML = `
    <div class="lobby-card waiting-card">
      <h2>Quick Match</h2>
      <p class="waiting-text" id="waiting-text">Waiting for players...</p>
      <p class="player-count" id="player-count">1/4</p>
      <ul class="player-list" id="player-list"></ul>
      <button class="btn-danger" id="leave-room">Leave Room</button>
      <p class="lobby-status" id="lobby-status" role="status" aria-live="polite" aria-atomic="true"></p>
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

  const items: HTMLLIElement[] = [];
  for (const [, player] of Object.entries(data.players) as [string, any][]) {
    const item = document.createElement('li');
    item.style.color = player.team === 'blue' ? '#4488ff' : '#ff8844';
    item.textContent = `${player.name} (${player.team})`;
    items.push(item);
  }

  listEl.replaceChildren(...items);
  countEl.textContent = `${items.length}/4`;
}

// ============================================================
// Screen 5: Custom Room Lobby
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
      <p class="lobby-status" id="lobby-status" role="status" aria-live="polite" aria-atomic="true"></p>
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

  const blueItems: HTMLLIElement[] = [];
  const orangeItems: HTMLLIElement[] = [];
  let localIsHost = false;

  for (const [sessionId, player] of Object.entries(data.players) as [string, any][]) {
    const isLocal = sessionId === room.sessionId;
    const item = document.createElement('li');
    if (isLocal) item.classList.add('local-player');
    item.append(document.createTextNode(String(player.name)));

    if (player.isHost) {
      const hostBadge = document.createElement('span');
      hostBadge.className = 'host-badge';
      hostBadge.textContent = 'HOST';
      item.append(' ', hostBadge);
    }

    if (player.team === 'blue') {
      blueItems.push(item);
    } else {
      orangeItems.push(item);
    }

    if (isLocal && player.isHost) {
      localIsHost = true;
    }
  }

  blueList.replaceChildren(...blueItems);
  orangeList.replaceChildren(...orangeItems);
  countEl.textContent = `${blueItems.length + orangeItems.length}/4`;

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
  } catch (error) {
    console.warn('[Lobby] Could not fetch room code:', error);
  }
}

// ============================================================
// Utility
// ============================================================

function getPlayerName(): string {
  const input = document.getElementById('lobby-name') as HTMLInputElement | null;

  // An unmounted main-menu input must never erase a captured or cached name.
  if (!input) return currentPlayerName;

  currentPlayerName = normalizePlayerName(input.value);
  input.value = currentPlayerName;
  localStorage.setItem(PLAYER_NAME_STORAGE_KEY, currentPlayerName);
  return currentPlayerName;
}

function getSavedName(): string {
  return normalizePlayerName(localStorage.getItem(PLAYER_NAME_STORAGE_KEY));
}

function setStatus(element: HTMLElement, message: string, isError = false): void {
  element.textContent = message;
  element.classList.toggle('is-error', isError);
}

function setActionPending(
  container: HTMLElement,
  activeButton: HTMLButtonElement,
  pending: boolean,
  pendingLabel: string,
): void {
  if (pending) {
    activeButton.dataset.idleLabel = activeButton.textContent ?? '';
    activeButton.textContent = pendingLabel;
    container.setAttribute('aria-busy', 'true');
  } else {
    activeButton.textContent = activeButton.dataset.idleLabel ?? activeButton.textContent;
    delete activeButton.dataset.idleLabel;
    container.removeAttribute('aria-busy');
  }

  container.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = pending;
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
      position: fixed;
      inset: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 1rem;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.85);
      font-family: monospace;
    }
    .lobby-card {
      box-sizing: border-box;
      width: min(500px, 100%);
      min-width: 0;
      max-height: calc(100vh - 2rem);
      max-height: calc(100dvh - 2rem);
      padding: 2rem;
      overflow-y: auto;
      background: #1a1a2e;
      border-radius: 12px;
      text-align: center;
    }
    .lobby-card h1 { color: #fff; margin-bottom: 1.5rem; font-size: 1.8rem; }
    .lobby-card h2 { color: #fff; margin: 0 0 1rem; font-size: 1.4rem; }
    .lobby-action-stack {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      width: 100%;
    }
    .lobby-card input {
      display: block;
      box-sizing: border-box;
      width: 100%;
      padding: 0.65rem;
      margin-bottom: 0.8rem;
      border: 1px solid #555;
      border-radius: 4px;
      background: #222;
      color: #fff;
      font-family: monospace;
      font-size: 1rem;
    }
    .lobby-action-stack > input,
    .lobby-action-stack > button { margin: 0; }
    .lobby-field-label {
      color: #d8d8e6;
      font-size: 0.9rem;
      font-weight: bold;
      text-align: left;
    }
    .room-code-input {
      letter-spacing: 0.2em;
      text-align: center;
      text-transform: uppercase;
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
      display: block; width: 100%; padding: 0.7rem;
      margin-bottom: 0.5rem; background: #2a9d8f; color: #fff;
      border: none; border-radius: 4px; font-weight: bold;
      cursor: pointer; font-family: monospace; font-size: 1rem;
    }
    .btn-accent:hover { background: #3ab8a8; }
    #lobby button:disabled {
      cursor: wait;
      opacity: 0.62;
    }
    #lobby button:focus-visible,
    #lobby input:focus-visible {
      outline: 3px solid #ffcc00;
      outline-offset: 2px;
    }
    .lobby-status {
      min-height: 2.4rem;
      margin: 1rem 0 0;
      color: #aaa;
      font-size: 0.8rem;
      line-height: 1.4;
    }
    .lobby-status.is-error { color: #ff9292; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

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
      flex: 1; min-width: 0; padding: 0.8rem; border-radius: 8px;
      min-height: 100px;
    }
    .blue-team { background: rgba(68, 136, 255, 0.15); border: 1px solid #4488ff; }
    .orange-team { background: rgba(255, 136, 68, 0.15); border: 1px solid #ff8844; }
    .team-column h3 { color: #fff; font-size: 0.9rem; margin-bottom: 0.5rem; }
    .team-column ul { list-style: none; padding: 0; margin: 0; text-align: left; }
    .team-column ul li { color: #ddd; padding: 0.2rem 0; font-size: 0.85rem; overflow-wrap: anywhere; }
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

    /* Responsive brand treatment */
    .lobby-card .lobby-brand {
      width: min(100%, 420px);
      margin: -0.25rem auto 1.15rem;
      color: #fff;
      font-size: inherit;
      line-height: 1;
    }
    .lobby-brand-wide {
      display: block;
      width: 100%;
      height: auto;
      object-fit: contain;
      filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.38));
      pointer-events: none;
      user-select: none;
    }
    .lobby-brand-compact {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 0.7rem;
    }
    .lobby-brand-mark {
      display: block;
      width: clamp(4rem, 20vw, 4.75rem);
      height: auto;
      flex: 0 0 auto;
      object-fit: contain;
      filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.42));
      pointer-events: none;
      user-select: none;
    }
    .lobby-brand-name {
      display: block;
      color: #f8fbff;
      font-family: Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif;
      font-size: clamp(1.35rem, 7vw, 1.85rem);
      font-style: italic;
      font-weight: 900;
      letter-spacing: 0.035em;
      line-height: 0.86;
      text-align: left;
      text-shadow: 0 3px 0 #071225, 0 7px 14px rgba(0, 0, 0, 0.45);
    }
    .lobby-brand-name > span { display: block; }
    .lobby-brand-arena {
      color: #27a8ff;
      background: linear-gradient(90deg, #27a8ff 0 49%, #ff8a1f 55% 100%);
      background-clip: text;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    @media (max-width: 420px) {
      .lobby-card { padding: 1.25rem; }
      .lobby-brand-wide { display: none; }
      .lobby-brand-compact { display: flex; }
    }
  `;
}
