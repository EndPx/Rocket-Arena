import {
  acceptedSnapshotStore,
  type AcceptedSnapshotUnsubscribe,
} from '../networking/accepted-snapshot-store.js';
import { getLocalSessionId } from '../networking/state-listener.js';
import {
  HUD_CONTROL_HINTS,
  HudModel,
  type HudCameraMode,
  type HudLocalPresentation,
  type HudViewModel,
} from './hud-model.js';
import type { BallIndicatorProjection } from './ball-indicator.js';

const HUD_STYLE_ID = 'rocket-arena-hud-styles';

let hudEl: HTMLElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let blueScoreEl: HTMLElement | null = null;
let orangeScoreEl: HTMLElement | null = null;
let blueNameEl: HTMLElement | null = null;
let orangeNameEl: HTMLElement | null = null;
let timerEl: HTMLElement | null = null;
let phaseEl: HTMLElement | null = null;
let centerEl: HTMLElement | null = null;
let liveRegionEl: HTMLElement | null = null;
let boostGaugeEl: HTMLElement | null = null;
let boostValueEl: HTMLElement | null = null;
let occupancyEl: HTMLElement | null = null;
let cameraEl: HTMLElement | null = null;
let indicatorEl: HTMLElement | null = null;

const model = new HudModel();
let unsubscribeAccepted: AcceptedSnapshotUnsubscribe | null = null;
let cameraMode: HudCameraMode | null = null;

function requireElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`HUD element missing: ${selector}`);
  return element;
}

function setText(element: HTMLElement | null, value: string): void {
  if (element && element.textContent !== value) element.textContent = value;
}

function localPresentation(): HudLocalPresentation {
  return { localSessionId: getLocalSessionId(), cameraMode };
}

/** Render one already-projected view model; this performs no state decisions. */
function render(view: HudViewModel): void {
  if (!hudEl) return;

  hudEl.dataset.active = String(view.active);
  hudEl.dataset.phase = view.phase;
  hudEl.dataset.urgent = String(view.clock.urgent);
  hudEl.setAttribute('aria-hidden', String(!view.active));

  setText(blueScoreEl, String(view.blue.score));
  setText(orangeScoreEl, String(view.orange.score));
  blueScoreEl?.setAttribute('aria-label', view.blue.ariaLabel);
  orangeScoreEl?.setAttribute('aria-label', view.orange.ariaLabel);
  setText(blueNameEl, view.blue.label);
  setText(orangeNameEl, view.orange.label);
  if (blueNameEl) blueNameEl.dataset.leading = String(view.blue.leading);
  if (orangeNameEl) orangeNameEl.dataset.leading = String(view.orange.leading);

  setText(timerEl, view.clock.text);
  timerEl?.setAttribute('aria-label', view.clock.ariaLabel);
  setText(phaseEl, view.phaseLabel);
  setText(centerEl, view.centerText);

  setText(occupancyEl, view.occupancy.text);
  occupancyEl?.setAttribute('aria-label', view.occupancy.ariaLabel);
  setText(cameraEl, view.camera.text);
  cameraEl?.setAttribute('aria-label', view.camera.ariaLabel);

  if (boostGaugeEl) {
    boostGaugeEl.style.setProperty('--boost', view.boost.gaugePercent.toFixed(2));
    boostGaugeEl.dataset.level = view.boost.level;
    if (view.boost.ariaValueNow === null) boostGaugeEl.removeAttribute('aria-valuenow');
    else boostGaugeEl.setAttribute('aria-valuenow', String(view.boost.ariaValueNow));
    boostGaugeEl.setAttribute('aria-valuetext', view.boost.ariaValueText);
  }
  setText(boostValueEl, view.boost.available ? String(view.boost.value) : '--');

  // One polite atomic announcement per stable authoritative event.
  if (view.announcement !== null) setText(liveRegionEl, view.announcement.announcement);
}

/** Project the currently accepted snapshot, or the idle view when there is none. */
function renderAccepted(): void {
  const snapshot = acceptedSnapshotStore.getSnapshot();
  const local = localPresentation();
  render(snapshot === null ? model.idle(local) : model.project(snapshot, local));
}

export function createHUD(): void {
  if (hudEl?.isConnected) return;

  document.getElementById('hud')?.remove();
  document.getElementById(HUD_STYLE_ID)?.remove();

  hudEl = document.createElement('aside');
  hudEl.id = 'hud';
  hudEl.dataset.active = 'false';
  hudEl.setAttribute('aria-label', 'Match status');
  hudEl.setAttribute('aria-hidden', 'true');
  hudEl.innerHTML = `
    <section class="hud-scoreboard" aria-label="Scoreboard">
      <div class="hud-team hud-team--blue">
        <span class="hud-team-name" id="hud-blue-name" data-leading="false">BLUE</span>
        <strong class="hud-score" id="hud-blue-score" aria-label="Blue score: 0">0</strong>
      </div>
      <div class="hud-clock-cell">
        <time class="hud-clock" id="hud-timer" aria-label="Match not started">5:00</time>
        <span class="hud-phase" id="hud-phase">WAITING</span>
      </div>
      <div class="hud-team hud-team--orange">
        <strong class="hud-score" id="hud-orange-score" aria-label="Orange score: 0">0</strong>
        <span class="hud-team-name" id="hud-orange-name" data-leading="false">ORANGE</span>
      </div>
    </section>

    <p class="hud-chip hud-chip--occupancy" id="hud-occupancy" aria-label="No room joined"></p>

    <div class="hud-center" id="hud-center" aria-hidden="true"></div>
    <div class="hud-live" id="hud-live" role="status" aria-live="polite" aria-atomic="true"></div>

    <div class="hud-ball-indicator" id="hud-ball-indicator" aria-hidden="true" hidden>
      <span class="hud-ball-indicator-arrow"></span>
    </div>

    <p class="hud-chip hud-chip--camera" id="hud-camera" aria-label="Camera: unavailable"></p>

    <section class="hud-controls" id="hud-controls" aria-label="Controls">
      <ul class="hud-controls-list">
        ${HUD_CONTROL_HINTS.map(({ keys, action, ariaLabel }) => `
        <li class="hud-control" aria-label="${ariaLabel}">
          <span class="hud-control-keys" aria-hidden="true">${
  keys.map((key) => `<kbd>${key}</kbd>`).join('<i>/</i>')
}</span>
          <span class="hud-control-action" aria-hidden="true">${action}</span>
        </li>`).join('')}
      </ul>
    </section>

    <div class="hud-boost" id="hud-boost-gauge" role="progressbar" aria-label="Boost" aria-valuemin="0" aria-valuemax="100" aria-valuetext="Boost unavailable">
      <div class="hud-boost-dial" aria-hidden="true">
        <div class="hud-boost-core">
          <strong class="hud-boost-value" id="hud-boost-value">--</strong>
          <span class="hud-boost-label">BOOST</span>
        </div>
      </div>
    </div>
  `;

  styleEl = document.createElement('style');
  styleEl.id = HUD_STYLE_ID;
  styleEl.textContent = `
    #hud {
      --hud-ink: #f4f8fb;
      --hud-muted: #a7b5c1;
      --hud-panel: rgba(8, 15, 23, 0.9);
      --hud-panel-deep: rgba(5, 10, 16, 0.96);
      --hud-line: rgba(188, 211, 225, 0.24);
      --hud-blue: #3b8dff;
      --hud-blue-deep: #123e78;
      --hud-orange: #ff8a3d;
      --hud-orange-deep: #753617;
      --hud-boost-color: #ffd05a;
      position: fixed;
      inset: 0;
      z-index: 10;
      pointer-events: none;
      color: var(--hud-ink);
      font-family: Inter, "Arial Narrow", "Segoe UI", sans-serif;
      font-variant-numeric: tabular-nums;
      transition: opacity 160ms ease;
    }

    #hud[data-active="false"] {
      opacity: 0;
      visibility: hidden;
    }

    .hud-scoreboard {
      position: absolute;
      top: max(16px, env(safe-area-inset-top));
      left: 50%;
      width: clamp(330px, 32vw, 452px);
      min-height: 64px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(112px, 0.9fr) minmax(0, 1fr);
      transform: translateX(-50%);
      filter: drop-shadow(0 8px 18px rgba(0, 0, 0, 0.34));
    }

    .hud-team,
    .hud-clock-cell {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      border-block: 1px solid var(--hud-line);
      background: var(--hud-panel);
      backdrop-filter: blur(12px) saturate(1.15);
    }

    .hud-team {
      gap: clamp(8px, 1vw, 14px);
      padding: 8px clamp(12px, 1.3vw, 18px);
    }

    .hud-team--blue {
      justify-content: flex-end;
      border-left: 1px solid rgba(70, 150, 255, 0.55);
      background: linear-gradient(100deg, rgba(18, 62, 120, 0.94), var(--hud-panel));
      clip-path: polygon(9px 0, 100% 0, 100% 100%, 0 100%, 0 9px);
    }

    .hud-team--orange {
      justify-content: flex-start;
      border-right: 1px solid rgba(255, 139, 62, 0.55);
      background: linear-gradient(260deg, rgba(117, 54, 23, 0.94), var(--hud-panel));
      clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%);
    }

    .hud-team::after {
      content: "";
      position: absolute;
      bottom: 0;
      width: 68%;
      height: 3px;
      background: currentColor;
      opacity: 0.9;
    }

    .hud-team--blue { color: var(--hud-blue); }
    .hud-team--orange { color: var(--hud-orange); }
    .hud-team--blue::after { right: 0; }
    .hud-team--orange::after { left: 0; }

    .hud-team-name {
      overflow: hidden;
      color: rgba(244, 248, 251, 0.82);
      font-size: clamp(0.62rem, 0.72vw, 0.72rem);
      font-weight: 800;
      letter-spacing: 0.16em;
      text-overflow: clip;
    }

    .hud-score {
      color: var(--hud-ink);
      font-size: clamp(1.8rem, 2.35vw, 2.35rem);
      font-weight: 850;
      line-height: 1;
      text-shadow: 0 2px 10px rgba(0, 0, 0, 0.32);
    }

    .hud-clock-cell {
      z-index: 1;
      flex-direction: column;
      gap: 2px;
      border-inline: 1px solid var(--hud-line);
      background: var(--hud-panel-deep);
      box-shadow: inset 0 -3px 0 rgba(255, 255, 255, 0.04);
    }

    .hud-clock {
      color: var(--hud-ink);
      font-size: clamp(1.45rem, 1.9vw, 1.9rem);
      font-weight: 800;
      line-height: 1;
      letter-spacing: 0.035em;
    }

    .hud-phase {
      max-width: 100%;
      overflow: hidden;
      color: var(--hud-muted);
      font-size: clamp(0.53rem, 0.62vw, 0.62rem);
      font-weight: 800;
      letter-spacing: 0.13em;
      line-height: 1.2;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #hud[data-phase="playing"][data-urgent="true"] .hud-clock,
    #hud[data-phase="playing"][data-urgent="true"] .hud-phase {
      color: #ff766e;
    }

    .hud-center {
      position: absolute;
      top: max(94px, calc(env(safe-area-inset-top) + 78px));
      left: 50%;
      min-width: 80px;
      max-width: min(76vw, 720px);
      transform: translateX(-50%);
      color: var(--hud-ink);
      font-size: clamp(1.2rem, 2.5vw, 2.4rem);
      font-weight: 900;
      letter-spacing: 0.08em;
      line-height: 1.05;
      text-align: center;
      text-shadow: 0 3px 14px rgba(0, 0, 0, 0.72);
    }

    .hud-center:empty { display: none; }

    /* Announcements are read by assistive technology, never painted twice. */
    .hud-live {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      border: 0;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .hud-chip {
      position: absolute;
      margin: 0;
      padding: 5px 10px;
      border: 1px solid var(--hud-line);
      border-radius: 4px;
      background: var(--hud-panel);
      color: var(--hud-ink);
      font-size: clamp(0.56rem, 0.68vw, 0.68rem);
      font-weight: 800;
      letter-spacing: 0.14em;
      line-height: 1;
      backdrop-filter: blur(10px);
    }

    .hud-chip:empty { display: none; }

    .hud-chip--occupancy {
      top: max(16px, env(safe-area-inset-top));
      left: max(20px, env(safe-area-inset-left));
    }

    .hud-chip--camera {
      bottom: max(26px, calc(env(safe-area-inset-bottom) + 2px));
      left: max(20px, env(safe-area-inset-left));
    }

    /*
     * The control strip is centred between the camera chip on the left and the
     * boost dial on the right, and it is inset from both so the three never
     * overlap at any supported width.
     */
    .hud-controls {
      position: absolute;
      bottom: max(22px, calc(env(safe-area-inset-bottom) + 2px));
      left: 50%;
      max-width: min(68vw, 840px);
      transform: translateX(-50%);
      opacity: 0.78;
    }

    .hud-controls-list {
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 5px 7px;
      justify-content: center;
      list-style: none;
    }

    .hud-control {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border: 1px solid var(--hud-line);
      border-radius: 4px;
      background: var(--hud-panel);
      backdrop-filter: blur(10px);
      white-space: nowrap;
    }

    .hud-control-keys {
      display: flex;
      align-items: center;
      gap: 3px;
      color: var(--hud-ink);
    }

    .hud-control-keys kbd {
      min-width: 15px;
      padding: 2px 4px;
      border: 1px solid rgba(188, 211, 225, 0.4);
      border-bottom-width: 2px;
      border-radius: 3px;
      background: rgba(30, 43, 54, 0.95);
      font-family: inherit;
      font-size: clamp(0.5rem, 0.6vw, 0.6rem);
      font-weight: 850;
      letter-spacing: 0.06em;
      line-height: 1;
      text-align: center;
    }

    .hud-control-keys i {
      color: var(--hud-muted);
      font-size: 0.5rem;
      font-style: normal;
    }

    .hud-control-action {
      color: var(--hud-muted);
      font-size: clamp(0.48rem, 0.58vw, 0.58rem);
      font-weight: 800;
      letter-spacing: 0.12em;
      line-height: 1;
    }

    .hud-ball-indicator {
      position: absolute;
      top: 0;
      left: 0;
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      transform: translate(-50%, -50%);
      will-change: transform;
    }

    .hud-ball-indicator[hidden] { display: none; }

    .hud-ball-indicator-arrow {
      width: 0;
      height: 0;
      border-top: 8px solid transparent;
      border-bottom: 8px solid transparent;
      border-left: 15px solid var(--hud-boost-color);
      filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.6));
    }

    .hud-ball-indicator[data-behind="true"] .hud-ball-indicator-arrow {
      opacity: 0.6;
    }

    .hud-team-name[data-leading="true"]::before {
      content: "\\25B8 ";
      color: currentColor;
    }

    .hud-boost {
      position: absolute;
      right: max(24px, env(safe-area-inset-right));
      bottom: max(24px, env(safe-area-inset-bottom));
      width: clamp(82px, 7.2vw, 104px);
      aspect-ratio: 1;
      filter: drop-shadow(0 9px 18px rgba(0, 0, 0, 0.38));
    }

    .hud-boost-dial {
      width: 100%;
      height: 100%;
      padding: 7px;
      border: 1px solid rgba(255, 208, 90, 0.34);
      border-radius: 50%;
      background:
        radial-gradient(circle, transparent 61%, rgba(255, 255, 255, 0.09) 62%, transparent 64%),
        conic-gradient(from 218deg, var(--hud-boost-color) calc(var(--boost, 0) * 1%), rgba(131, 145, 154, 0.2) 0 76%, transparent 76% 100%);
      transform: rotate(-8deg);
      box-sizing: border-box;
    }

    .hud-boost-core {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--hud-line);
      border-radius: 50%;
      background: radial-gradient(circle at 42% 32%, rgba(32, 45, 56, 0.97), rgba(6, 12, 19, 0.98) 72%);
      transform: rotate(8deg);
      box-sizing: border-box;
    }

    .hud-boost-value {
      font-size: clamp(1.65rem, 2.4vw, 2.25rem);
      font-weight: 850;
      line-height: 0.9;
    }

    .hud-boost-label {
      margin-top: 6px;
      color: var(--hud-muted);
      font-size: clamp(0.5rem, 0.58vw, 0.6rem);
      font-weight: 850;
      letter-spacing: 0.17em;
    }

    .hud-boost[data-level="low"] { --hud-boost-color: #ff984f; }
    .hud-boost[data-level="critical"] { --hud-boost-color: #ff625c; }
    .hud-boost[data-level="unavailable"] { --hud-boost-color: #67747d; opacity: 0.64; }

    @media (max-width: 760px) {
      .hud-scoreboard {
        top: max(10px, env(safe-area-inset-top));
        width: min(342px, calc(100vw - 24px));
        min-height: 56px;
        grid-template-columns: minmax(0, 1fr) 108px minmax(0, 1fr);
      }
      .hud-team { gap: 7px; padding-inline: 10px; }
      .hud-team-name { max-width: 34px; letter-spacing: 0.08em; }
      .hud-center { top: max(78px, calc(env(safe-area-inset-top) + 66px)); }
      .hud-chip--occupancy {
        top: max(10px, env(safe-area-inset-top));
        left: max(12px, env(safe-area-inset-left));
      }
      .hud-chip--camera {
        bottom: max(16px, env(safe-area-inset-bottom));
        left: max(12px, env(safe-area-inset-left));
      }
      .hud-boost {
        right: max(14px, env(safe-area-inset-right));
        bottom: max(14px, env(safe-area-inset-bottom));
        width: 78px;
      }
      /* Narrow widths cannot fit the strip beside the dial, so it moves above. */
      .hud-controls {
        bottom: max(104px, calc(env(safe-area-inset-bottom) + 92px));
        max-width: min(92vw, 520px);
      }
    }

    @media (max-height: 620px) {
      .hud-scoreboard { top: max(8px, env(safe-area-inset-top)); }
      .hud-center { top: max(76px, calc(env(safe-area-inset-top) + 64px)); }
      .hud-boost { bottom: max(12px, env(safe-area-inset-bottom)); width: 76px; }
      .hud-controls { bottom: max(14px, calc(env(safe-area-inset-bottom) + 2px)); }
    }

    /* A pointer-only device has no keys to press, so the reference is noise. */
    @media (hover: none) and (pointer: coarse) {
      .hud-controls { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      #hud { transition: none; }
    }
  `;

  document.head.appendChild(styleEl);
  document.body.appendChild(hudEl);

  blueScoreEl = requireElement(hudEl, '#hud-blue-score');
  orangeScoreEl = requireElement(hudEl, '#hud-orange-score');
  blueNameEl = requireElement(hudEl, '#hud-blue-name');
  orangeNameEl = requireElement(hudEl, '#hud-orange-name');
  timerEl = requireElement(hudEl, '#hud-timer');
  phaseEl = requireElement(hudEl, '#hud-phase');
  centerEl = requireElement(hudEl, '#hud-center');
  liveRegionEl = requireElement(hudEl, '#hud-live');
  boostGaugeEl = requireElement(hudEl, '#hud-boost-gauge');
  boostValueEl = requireElement(hudEl, '#hud-boost-value');
  occupancyEl = requireElement(hudEl, '#hud-occupancy');
  cameraEl = requireElement(hudEl, '#hud-camera');
  indicatorEl = requireElement(hudEl, '#hud-ball-indicator');

  // The HUD is a subscriber of the acceptance boundary, not a poller of raw
  // room state. A rejected snapshot never reaches this callback.
  unsubscribeAccepted = acceptedSnapshotStore.subscribe((change) => {
    if (change.type === 'reset') {
      model.reset();
      cameraMode = null;
      setText(liveRegionEl, '');
      hideBallIndicator();
    }
    renderAccepted();
  });

  renderAccepted();
}

function hideBallIndicator(): void {
  if (!indicatorEl || indicatorEl.hidden) return;
  indicatorEl.hidden = true;
  indicatorEl.dataset.behind = 'false';
}

function renderBallIndicator(projection: BallIndicatorProjection | null): void {
  if (!indicatorEl) return;
  if (projection === null || !projection.visible) {
    hideBallIndicator();
    return;
  }

  indicatorEl.hidden = false;
  indicatorEl.dataset.behind = String(projection.behindCamera);
  indicatorEl.style.transform = `translate(-50%, -50%)`
    + ` translate(${projection.position.x.toFixed(1)}px, ${projection.position.y.toFixed(1)}px)`
    + ` rotate(${projection.angleRadians.toFixed(4)}rad)`;
}

export interface HudFrameInput {
  /** Local camera mode; presentation only. */
  readonly cameraMode: HudCameraMode | null;
  /** Latest off-screen ball projection, or null when the ball is on screen. */
  readonly ballIndicator: BallIndicatorProjection | null;
}

/**
 * Apply the local presentation values that are not part of accepted state.
 * Accepted score, clock, phase, boost, and notices arrive through the store
 * subscription instead of being polled here.
 */
export function updateHUD(input: HudFrameInput): void {
  if (!hudEl) return;
  const changedMode = cameraMode !== input.cameraMode;
  cameraMode = input.cameraMode;
  renderBallIndicator(input.ballIndicator);
  if (changedMode) renderAccepted();
}

/** Show or hide the on-screen control reference, driven by client settings. */
export function setControlHintsVisible(visible: boolean): void {
  hudEl?.querySelector('#hud-controls')?.toggleAttribute('hidden', !visible);
}

export function resetHUD(): void {
  if (!hudEl || hudEl.dataset.active === 'false') return;
  model.reset();
  cameraMode = null;
  setText(liveRegionEl, '');
  hideBallIndicator();
  render(model.idle());
}

export function destroyHUD(): void {
  unsubscribeAccepted?.();
  unsubscribeAccepted = null;
  model.reset();
  cameraMode = null;
  hudEl?.remove();
  styleEl?.remove();
  hudEl = null;
  styleEl = null;
  blueScoreEl = null;
  orangeScoreEl = null;
  blueNameEl = null;
  orangeNameEl = null;
  timerEl = null;
  phaseEl = null;
  centerEl = null;
  liveRegionEl = null;
  boostGaugeEl = null;
  boostValueEl = null;
  occupancyEl = null;
  cameraEl = null;
  indicatorEl = null;
}
