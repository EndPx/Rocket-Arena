import type { Room } from 'colyseus.js';

let hudEl: HTMLElement;
let blueScoreEl: HTMLElement;
let orangeScoreEl: HTMLElement;
let timerEl: HTMLElement;
let boostBarEl: HTMLElement;
let centerTextEl: HTMLElement;

export function createHUD(): void {
  hudEl = document.createElement('div');
  hudEl.id = 'hud';
  hudEl.innerHTML = `
    <div class="hud-top">
      <span class="hud-score blue" id="hud-blue-score">0</span>
      <span class="hud-timer" id="hud-timer">5:00</span>
      <span class="hud-score orange" id="hud-orange-score">0</span>
    </div>
    <div class="hud-center" id="hud-center"></div>
    <div class="hud-bottom">
      <div class="hud-boost-label">BOOST</div>
      <div class="hud-boost-track"><div class="hud-boost-fill" id="hud-boost"></div></div>
    </div>
  `;
  document.body.appendChild(hudEl);

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #hud { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; font-family: monospace; z-index: 10; }
    .hud-top { display: flex; justify-content: center; align-items: center; gap: 2rem; padding: 1rem; }
    .hud-score { font-size: 2.5rem; font-weight: bold; text-shadow: 0 2px 4px rgba(0,0,0,0.5); }
    .hud-score.blue { color: #3366ff; }
    .hud-score.orange { color: #ff6633; }
    .hud-timer { font-size: 1.5rem; color: #fff; background: rgba(0,0,0,0.5); padding: 0.3rem 1rem; border-radius: 4px; }
    .hud-center { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 3rem; font-weight: bold; color: #fff; text-shadow: 0 4px 8px rgba(0,0,0,0.7); text-align: center; }
    .hud-bottom { position: absolute; bottom: 2rem; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 0.5rem; }
    .hud-boost-label { color: #ffa500; font-size: 0.8rem; font-weight: bold; }
    .hud-boost-track { width: 200px; height: 12px; background: rgba(0,0,0,0.5); border-radius: 6px; overflow: hidden; }
    .hud-boost-fill { height: 100%; background: linear-gradient(90deg, #ff8800, #ffcc00); transition: width 0.1s; width: 33%; }
  `;
  document.head.appendChild(style);

  blueScoreEl = document.getElementById('hud-blue-score')!;
  orangeScoreEl = document.getElementById('hud-orange-score')!;
  timerEl = document.getElementById('hud-timer')!;
  boostBarEl = document.getElementById('hud-boost')!;
  centerTextEl = document.getElementById('hud-center')!;
}

export function updateHUD(room: Room): void {
  const state = room.state as any;

  // Scores
  blueScoreEl.textContent = String(state.blueScore || 0);
  orangeScoreEl.textContent = String(state.orangeScore || 0);

  // Timer
  const time = state.timeRemaining || 0;
  if (time < 0) {
    timerEl.textContent = '+OT';
    timerEl.style.color = '#ff4444';
  } else {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    timerEl.style.color = time < 30 ? '#ff4444' : '#fff';
  }

  // Boost (use local player's boost value)
  const localPlayer = getLocalPlayer(room);
  const boost = localPlayer?.boost ?? 33;
  boostBarEl.style.width = `${boost}%`;

  // Center text based on phase
  const phase = state.phase || 'waiting';
  switch (phase) {
    case 'countdown': {
      const countdown = Math.ceil(time);
      centerTextEl.textContent = countdown > 0 ? String(countdown) : 'GO!';
      break;
    }
    case 'goal-scored':
      centerTextEl.textContent = 'GOAL!';
      break;
    case 'overtime':
      centerTextEl.textContent = ''; // Just show +OT in timer
      break;
    case 'ended': {
      const winner = (state.blueScore || 0) > (state.orangeScore || 0) ? 'BLUE' : 'ORANGE';
      centerTextEl.textContent = `${winner} WINS!`;
      break;
    }
    default:
      centerTextEl.textContent = '';
  }
}

function getLocalPlayer(room: Room): any {
  return (room.state as any).players?.get(room.sessionId);
}
