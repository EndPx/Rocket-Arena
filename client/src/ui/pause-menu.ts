import {
  getAudioSettings,
  setAudioMuted,
  setAudioVolume,
} from '../audio/audio-manager.js';
import { setControlHintsVisible } from '../hud/hud.js';
import { isEditableTarget } from '../input/input-controller.js';
import { setAxisInversion, setInputSuspended } from '../input/keyboard-handler.js';
import {
  DEFAULT_CLIENT_SETTINGS,
  composeClientSettings,
  defaultPersistedSettings,
  isDefaultClientSettings,
  loadPersistedSettings,
  savePersistedSettings,
  type ClientSettings,
  type PersistedClientSettings,
  type PersistedSettingKey,
} from './settings-model.js';

const MENU_ID = 'pause-menu';
const MENU_STYLE_ID = 'rocket-arena-pause-menu-styles';

/**
 * The axis-inversion rows, named by the keys they affect rather than by an
 * abstraction, because that is how a player recognises the one they want. Driven
 * from a list so the markup, the click wiring, and the reset cannot disagree.
 */
const INVERSION_ROWS = Object.freeze([
  { id: 'pause-invert-drive', key: 'invertDrive', label: 'Invert W / S (drive)' },
  { id: 'pause-invert-steer', key: 'invertSteer', label: 'Invert A / D (steer)' },
  { id: 'pause-invert-airyaw', key: 'invertAirYaw', label: 'Invert Q / E (air yaw)' },
] as const satisfies readonly {
  readonly id: string;
  readonly key: PersistedSettingKey;
  readonly label: string;
}[]);

export interface PauseMenuHooks {
  /** Whether a match is currently joined; the menu only opens in-match. */
  isInMatch(): boolean;
  /** Leave the room and go back to the lobby. */
  returnToLobby(): void;
  /** Apply the ball floor circle toggle to the renderer. */
  applyBallMarkerVisible(visible: boolean): void;
}

let menuEl: HTMLElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let hooks: PauseMenuHooks | null = null;
let keydownListener: ((event: KeyboardEvent) => void) | null = null;
let persisted: PersistedClientSettings = loadPersistedSettings(null);
let open = false;
let panel: 'root' | 'settings' = 'root';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some privacy modes throw on the property access itself.
    return null;
  }
}

function settings(): ClientSettings {
  return composeClientSettings(persisted, getAudioSettings());
}

/**
 * Push the current settings into the systems that own them.
 *
 * Sound goes to the audio manager, which is the single owner of that state, the
 * two visibility toggles go to the renderer and the HUD, and the inversion flags
 * go to the input controller. Called on every change and once at startup so a
 * stored preference takes effect before the first frame.
 */
function applySettings(next: ClientSettings): void {
  setAudioMuted(next.muted);
  setAudioVolume(next.soundVolume);
  setControlHintsVisible(next.showControlHints);
  hooks?.applyBallMarkerVisible(next.showBallMarker);
  setAxisInversion({
    drive: next.invertDrive,
    steer: next.invertSteer,
    airYaw: next.invertAirYaw,
  });
}

function persist(next: PersistedClientSettings): void {
  persisted = next;
  savePersistedSettings(storage(), persisted);
}

function renderPanel(): void {
  if (!menuEl) return;
  const current = settings();
  menuEl.dataset.panel = panel;

  if (panel === 'root') {
    menuEl.innerHTML = `
      <div class="pause-card" role="dialog" aria-modal="true" aria-label="Match menu">
        <h2>PAUSED</h2>
        <p class="pause-note">The match keeps running. This menu is yours alone.</p>
        <div class="pause-actions">
          <button type="button" class="pause-btn pause-btn--primary" id="pause-resume">Resume</button>
          <button type="button" class="pause-btn" id="pause-settings">Settings</button>
          <button type="button" class="pause-btn pause-btn--danger" id="pause-return">Return to Lobby</button>
        </div>
        <p class="pause-hint">Press ESC to resume</p>
      </div>
    `;
    menuEl.querySelector('#pause-resume')?.addEventListener('click', () => closeMenu());
    menuEl.querySelector('#pause-settings')?.addEventListener('click', () => {
      panel = 'settings';
      renderPanel();
    });
    menuEl.querySelector('#pause-return')?.addEventListener('click', () => {
      closeMenu();
      hooks?.returnToLobby();
    });
    menuEl.querySelector<HTMLButtonElement>('#pause-resume')?.focus();
    return;
  }

  const volumePercent = Math.round(current.soundVolume * 100);
  menuEl.innerHTML = `
    <div class="pause-card" role="dialog" aria-modal="true" aria-label="Settings">
      <h2>SETTINGS</h2>
      <div class="pause-settings">
        <div class="pause-row">
          <label class="pause-label" for="pause-volume">Sound volume</label>
          <div class="pause-control">
            <input
              type="range"
              id="pause-volume"
              min="0"
              max="1"
              step="0.05"
              value="${current.soundVolume}"
              aria-valuetext="${volumePercent} percent"
            >
            <output for="pause-volume" id="pause-volume-value">${volumePercent}%</output>
          </div>
        </div>
        <div class="pause-row">
          <span class="pause-label" id="pause-mute-label">Mute sound</span>
          <button
            type="button"
            class="pause-toggle"
            id="pause-mute"
            aria-pressed="${current.muted}"
            aria-labelledby="pause-mute-label"
          >${current.muted ? 'ON' : 'OFF'}</button>
        </div>
        <div class="pause-row">
          <span class="pause-label" id="pause-marker-label">Ball floor marker</span>
          <button
            type="button"
            class="pause-toggle"
            id="pause-marker"
            aria-pressed="${current.showBallMarker}"
            aria-labelledby="pause-marker-label"
          >${current.showBallMarker ? 'ON' : 'OFF'}</button>
        </div>
        <div class="pause-row">
          <span class="pause-label" id="pause-hints-label">Control hints</span>
          <button
            type="button"
            class="pause-toggle"
            id="pause-hints"
            aria-pressed="${current.showControlHints}"
            aria-labelledby="pause-hints-label"
          >${current.showControlHints ? 'ON' : 'OFF'}</button>
        </div>
        ${INVERSION_ROWS.map((row) => `
        <div class="pause-row">
          <span class="pause-label" id="${row.id}-label">${row.label}</span>
          <button
            type="button"
            class="pause-toggle"
            id="${row.id}"
            aria-pressed="${current[row.key]}"
            aria-labelledby="${row.id}-label"
          >${current[row.key] ? 'ON' : 'OFF'}</button>
        </div>`).join('')}
      </div>
      <div class="pause-actions">
        <button
          type="button"
          class="pause-btn"
          id="pause-reset"
          ${isDefaultClientSettings(current) ? 'disabled' : ''}
        >Reset to Defaults</button>
        <button type="button" class="pause-btn pause-btn--primary" id="pause-back">Back</button>
      </div>
      <p class="pause-status" id="pause-status" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
  `;

  const volume = menuEl.querySelector<HTMLInputElement>('#pause-volume');
  volume?.addEventListener('input', () => {
    const value = Number(volume.value);
    setAudioVolume(Number.isFinite(value) ? value : DEFAULT_CLIENT_SETTINGS.soundVolume);
    renderPanel();
  });

  menuEl.querySelector('#pause-mute')?.addEventListener('click', () => {
    setAudioMuted(!settings().muted);
    renderPanel();
  });
  menuEl.querySelector('#pause-marker')?.addEventListener('click', () => {
    persist({ ...persisted, showBallMarker: !persisted.showBallMarker });
    applySettings(settings());
    renderPanel();
  });
  menuEl.querySelector('#pause-hints')?.addEventListener('click', () => {
    persist({ ...persisted, showControlHints: !persisted.showControlHints });
    applySettings(settings());
    renderPanel();
  });
  for (const row of INVERSION_ROWS) {
    menuEl.querySelector(`#${row.id}`)?.addEventListener('click', () => {
      persist({ ...persisted, [row.key]: !persisted[row.key] });
      applySettings(settings());
      renderPanel();
    });
  }
  menuEl.querySelector('#pause-reset')?.addEventListener('click', () => {
    persist(defaultPersistedSettings());
    applySettings(DEFAULT_CLIENT_SETTINGS);
    renderPanel();
    const status = menuEl?.querySelector('#pause-status');
    if (status) status.textContent = 'Settings reset to defaults.';
  });
  menuEl.querySelector('#pause-back')?.addEventListener('click', () => {
    panel = 'root';
    renderPanel();
  });
  menuEl.querySelector<HTMLButtonElement>('#pause-back')?.focus();
}

function openMenu(): void {
  if (open || !menuEl || hooks?.isInMatch() !== true) return;
  open = true;
  panel = 'root';
  // The car must stop while the menu has the keyboard, but the room, the input
  // transport, and the monotonic edge floors all stay intact.
  setInputSuspended(true);
  menuEl.hidden = false;
  menuEl.setAttribute('aria-hidden', 'false');
  renderPanel();
}

function closeMenu(): void {
  if (!open || !menuEl) return;
  open = false;
  panel = 'root';
  setInputSuspended(false);
  menuEl.hidden = true;
  menuEl.setAttribute('aria-hidden', 'true');
  menuEl.replaceChildren();
}

export function isPauseMenuOpen(): boolean {
  return open;
}

/** Close the menu without leaving the room; used when a match ends underneath it. */
export function closePauseMenu(): void {
  closeMenu();
}

export function createPauseMenu(menuHooks: PauseMenuHooks): void {
  if (menuEl?.isConnected) return;
  document.getElementById(MENU_ID)?.remove();
  document.getElementById(MENU_STYLE_ID)?.remove();

  hooks = menuHooks;
  persisted = loadPersistedSettings(storage());

  styleEl = document.createElement('style');
  styleEl.id = MENU_STYLE_ID;
  // Above the HUD, lobby, and game-over card, and above the sound aside so the
  // panel is not competing with a duplicate volume slider. The dev panel stays on
  // top of everything, which is what it is for.
  styleEl.textContent = `
    #${MENU_ID} {
      position: fixed;
      inset: 0;
      z-index: 90;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 1rem;
      background: rgba(4, 7, 13, 0.78);
      color: #e9f4f6;
      font-family: monospace;
      backdrop-filter: blur(0.2rem);
    }

    #${MENU_ID}[hidden] { display: none; }

    #${MENU_ID} .pause-card {
      box-sizing: border-box;
      width: min(420px, 100%);
      max-height: calc(100dvh - 2rem);
      padding: 1.6rem;
      overflow-y: auto;
      border: 1px solid rgba(188, 211, 225, 0.24);
      border-radius: 0.6rem;
      background: #1a1a2e;
      text-align: center;
    }

    #${MENU_ID} h2 {
      margin: 0 0 0.5rem;
      font-size: 1.35rem;
      letter-spacing: 0.16em;
    }

    #${MENU_ID} .pause-note,
    #${MENU_ID} .pause-hint,
    #${MENU_ID} .pause-status {
      margin: 0.5rem 0 0;
      color: #a7b5c1;
      font-size: 0.72rem;
      line-height: 1.5;
    }

    #${MENU_ID} .pause-note { margin-bottom: 1.1rem; }
    #${MENU_ID} .pause-status:empty { display: none; }

    #${MENU_ID} .pause-actions {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      margin-top: 1.1rem;
    }

    #${MENU_ID} .pause-btn {
      padding: 0.7rem 0.9rem;
      border: 1px solid rgba(188, 211, 225, 0.32);
      border-radius: 0.35rem;
      background: rgba(39, 50, 60, 0.9);
      color: inherit;
      font: inherit;
      font-weight: 700;
      letter-spacing: 0.1em;
      cursor: pointer;
    }

    #${MENU_ID} .pause-btn--primary {
      border-color: rgba(102, 183, 255, 0.7);
      background: rgba(47, 120, 255, 0.24);
    }

    #${MENU_ID} .pause-btn--danger {
      border-color: rgba(255, 106, 42, 0.7);
      background: rgba(255, 106, 42, 0.18);
    }

    #${MENU_ID} .pause-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    #${MENU_ID} .pause-settings {
      display: flex;
      flex-direction: column;
      gap: 0.7rem;
      margin-top: 0.9rem;
      text-align: left;
    }

    #${MENU_ID} .pause-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.8rem;
    }

    #${MENU_ID} .pause-label {
      color: #d8e2e8;
      font-size: 0.78rem;
    }

    #${MENU_ID} .pause-control {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    #${MENU_ID} input[type="range"] {
      width: 7.5rem;
      margin: 0;
      accent-color: #66b7ff;
      cursor: pointer;
    }

    #${MENU_ID} output {
      min-width: 2.6rem;
      color: #a7b5c1;
      font-size: 0.72rem;
      text-align: right;
    }

    #${MENU_ID} .pause-toggle {
      min-width: 3.4rem;
      padding: 0.4rem 0.6rem;
      border: 1px solid rgba(188, 211, 225, 0.32);
      border-radius: 0.3rem;
      background: rgba(39, 50, 60, 0.9);
      color: #a7b5c1;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    #${MENU_ID} .pause-toggle[aria-pressed="true"] {
      border-color: rgba(102, 183, 255, 0.7);
      background: rgba(47, 120, 255, 0.24);
      color: #e9f4f6;
    }

    #${MENU_ID} button:focus-visible,
    #${MENU_ID} input:focus-visible {
      outline: 3px solid #ffcc00;
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(styleEl);

  menuEl = document.createElement('div');
  menuEl.id = MENU_ID;
  menuEl.hidden = true;
  menuEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(menuEl);

  keydownListener = (event: KeyboardEvent): void => {
    if (event.code !== 'Escape' || event.repeat) return;
    // Never steal Escape from a text field; the lobby name input needs it.
    if (!open && isEditableTarget(event.target)) return;
    event.preventDefault();
    if (open) {
      // Escape backs out of Settings first, then closes, so it never discards a
      // panel the player is still reading.
      if (panel === 'settings') {
        panel = 'root';
        renderPanel();
        return;
      }
      closeMenu();
      return;
    }
    openMenu();
  };
  window.addEventListener('keydown', keydownListener);

  // A stored preference has to take effect before the first frame is presented.
  applySettings(settings());
}

export function destroyPauseMenu(): void {
  if (keydownListener) window.removeEventListener('keydown', keydownListener);
  keydownListener = null;
  if (open) setInputSuspended(false);
  open = false;
  panel = 'root';
  menuEl?.remove();
  styleEl?.remove();
  menuEl = null;
  styleEl = null;
  hooks = null;
}
