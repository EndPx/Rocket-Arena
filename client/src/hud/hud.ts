import type { Room } from 'colyseus.js';
import { getLocalState, type StateSync } from '../networking/state-listener.js';

const HUD_STYLE_ID = 'rocket-arena-hud-styles';

let hudEl: HTMLElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let blueScoreEl: HTMLElement | null = null;
let orangeScoreEl: HTMLElement | null = null;
let timerEl: HTMLElement | null = null;
let phaseEl: HTMLElement | null = null;
let announcementEl: HTMLElement | null = null;
let boostGaugeEl: HTMLElement | null = null;
let boostValueEl: HTMLElement | null = null;

function requireElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`HUD element missing: ${selector}`);
  return element;
}

function setText(element: HTMLElement | null, value: string): void {
  if (element && element.textContent !== value) element.textContent = value;
}

function formatClock(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function phaseLabel(state: Readonly<StateSync>): string {
  switch (state.phase) {
    case 'waiting':
      return 'WAITING FOR PLAYERS';
    case 'countdown':
      if (state.countdownKind === 'post-goal') return 'RESET · KICKOFF';
      if (state.countdownKind === 'overtime') return 'OVERTIME KICKOFF';
      return 'KICKOFF';
    case 'goal-reset':
      return 'GOAL RESET';
    case 'overtime':
      return 'SUDDEN DEATH';
    case 'ended':
      return state.winner ? `${state.winner.toUpperCase()} VICTORY` : 'MATCH COMPLETE';
    case 'playing':
    default:
      return state.regulationSecondsRemaining <= 30 ? 'FINAL SECONDS' : 'REGULATION';
  }
}

function clockLabel(state: Readonly<StateSync>): string {
  if (state.phase === 'overtime') return 'OT';
  if (state.phase === 'ended') return 'FINAL';
  return formatClock(state.regulationSecondsRemaining);
}

function announcement(state: Readonly<StateSync>): string {
  if (state.phase === 'countdown') {
    return String(Math.max(1, Math.ceil(state.phaseSecondsRemaining)));
  }
  if (state.phase === 'goal-reset') return 'GOAL';
  if (state.phase === 'ended') {
    return state.winner ? `${state.winner.toUpperCase()} WINS` : 'MATCH COMPLETE';
  }
  return '';
}

function resetBoost(): void {
  if (!boostGaugeEl || !boostValueEl) return;
  boostGaugeEl.style.setProperty('--boost', '0');
  boostGaugeEl.dataset.level = 'unavailable';
  boostGaugeEl.removeAttribute('aria-valuenow');
  boostGaugeEl.setAttribute('aria-valuetext', 'Boost unavailable');
  setText(boostValueEl, '--');
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
        <span class="hud-team-name">BLUE</span>
        <strong class="hud-score" id="hud-blue-score" aria-label="Blue score: 0">0</strong>
      </div>
      <div class="hud-clock-cell">
        <time class="hud-clock" id="hud-timer" aria-label="Time remaining: 5 minutes">5:00</time>
        <span class="hud-phase" id="hud-phase">WAITING</span>
      </div>
      <div class="hud-team hud-team--orange">
        <strong class="hud-score" id="hud-orange-score" aria-label="Orange score: 0">0</strong>
        <span class="hud-team-name">ORANGE</span>
      </div>
    </section>

    <div class="hud-announcement" id="hud-announcement" role="status" aria-live="polite" aria-atomic="true"></div>

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

    .hud-announcement {
      position: absolute;
      top: max(94px, calc(env(safe-area-inset-top) + 78px));
      left: 50%;
      min-width: 80px;
      transform: translateX(-50%);
      color: var(--hud-ink);
      font-size: clamp(1.45rem, 2.8vw, 2.65rem);
      font-weight: 900;
      letter-spacing: 0.08em;
      line-height: 1;
      text-align: center;
      text-shadow: 0 3px 14px rgba(0, 0, 0, 0.72);
    }

    .hud-announcement:empty { display: none; }

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
      .hud-team-name { max-width: 26px; letter-spacing: 0.08em; }
      .hud-announcement { top: max(78px, calc(env(safe-area-inset-top) + 66px)); }
      .hud-boost {
        right: max(14px, env(safe-area-inset-right));
        bottom: max(14px, env(safe-area-inset-bottom));
        width: 78px;
      }
    }

    @media (max-height: 620px) {
      .hud-scoreboard { top: max(8px, env(safe-area-inset-top)); }
      .hud-announcement { top: max(76px, calc(env(safe-area-inset-top) + 64px)); }
      .hud-boost { bottom: max(12px, env(safe-area-inset-bottom)); width: 76px; }
    }

    @media (prefers-reduced-motion: reduce) {
      #hud { transition: none; }
    }
  `;

  document.head.appendChild(styleEl);
  document.body.appendChild(hudEl);

  blueScoreEl = requireElement(hudEl, '#hud-blue-score');
  orangeScoreEl = requireElement(hudEl, '#hud-orange-score');
  timerEl = requireElement(hudEl, '#hud-timer');
  phaseEl = requireElement(hudEl, '#hud-phase');
  announcementEl = requireElement(hudEl, '#hud-announcement');
  boostGaugeEl = requireElement(hudEl, '#hud-boost-gauge');
  boostValueEl = requireElement(hudEl, '#hud-boost-value');
  resetBoost();
}

export function updateHUD(room: Room): void {
  const state = getLocalState();
  if (!hudEl || !state) {
    resetHUD();
    return;
  }

  hudEl.dataset.active = 'true';
  hudEl.dataset.phase = state.phase;
  hudEl.dataset.urgent = String(
    state.phase === 'playing' && state.regulationSecondsRemaining <= 30,
  );
  hudEl.setAttribute('aria-hidden', 'false');

  setText(blueScoreEl, String(state.blueScore));
  setText(orangeScoreEl, String(state.orangeScore));
  blueScoreEl?.setAttribute('aria-label', `Blue score: ${state.blueScore}`);
  orangeScoreEl?.setAttribute('aria-label', `Orange score: ${state.orangeScore}`);

  const displayedClock = clockLabel(state);
  setText(timerEl, displayedClock);
  timerEl?.setAttribute('aria-label', state.phase === 'overtime'
    ? 'Overtime'
    : `Time remaining: ${displayedClock}`);
  setText(phaseEl, phaseLabel(state));
  setText(announcementEl, announcement(state));

  const localPlayer = state.players[room.sessionId];
  if (!localPlayer) {
    resetBoost();
    return;
  }

  const boost = Math.min(100, Math.max(0, localPlayer.boost));
  boostGaugeEl?.style.setProperty('--boost', boost.toFixed(2));
  if (boostGaugeEl) {
    boostGaugeEl.dataset.level = boost <= 10 ? 'critical' : boost <= 25 ? 'low' : 'ready';
    boostGaugeEl.setAttribute('aria-valuenow', String(Math.round(boost)));
    boostGaugeEl.setAttribute('aria-valuetext', `${Math.round(boost)} boost`);
  }
  setText(boostValueEl, String(Math.round(boost)));
}

export function resetHUD(): void {
  if (!hudEl || hudEl.dataset.active === 'false') return;
  hudEl.dataset.active = 'false';
  hudEl.dataset.phase = 'waiting';
  hudEl.dataset.urgent = 'false';
  hudEl.setAttribute('aria-hidden', 'true');
  setText(blueScoreEl, '0');
  setText(orangeScoreEl, '0');
  setText(timerEl, '5:00');
  setText(phaseEl, 'WAITING');
  setText(announcementEl, '');
  resetBoost();
}

export function destroyHUD(): void {
  hudEl?.remove();
  styleEl?.remove();
  hudEl = null;
  styleEl = null;
  blueScoreEl = null;
  orangeScoreEl = null;
  timerEl = null;
  phaseEl = null;
  announcementEl = null;
  boostGaugeEl = null;
  boostValueEl = null;
}
