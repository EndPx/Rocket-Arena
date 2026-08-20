import type {
  CountdownKind,
  MatchPhase,
  MatchTransitionSnapshot,
  RoomMode,
  Team,
} from '@rocket-arena/shared';

/** Camera modes the HUD can report; mirrors the local camera controller. */
export type HudCameraMode = 'orbit' | 'ball' | 'car';

/**
 * The accepted fields the HUD reads. A decoded snapshot satisfies this
 * structurally, so the model never parses raw room state and never synthesizes
 * an authoritative outcome of its own.
 */
export interface HudSnapshotInput {
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly regulationSecondsRemaining: number;
  readonly phaseSecondsRemaining: number;
  readonly winner: Team | null;
  readonly roomMode: RoomMode;
  readonly totalCapacity: number;
  readonly teamCapacity: number;
  readonly latestTransition: Readonly<MatchTransitionSnapshot> | null;
  readonly cars: readonly {
    readonly sessionId: string;
    readonly team: Team;
    readonly boost: number;
  }[];
}

/** Local, non-authoritative presentation context owned by this client. */
export interface HudLocalPresentation {
  readonly localSessionId: string | null;
  readonly cameraMode: HudCameraMode | null;
}

export interface HudTeamModel {
  readonly team: Team;
  /** Text label so Blue and Orange are distinguishable without colour. */
  readonly label: string;
  readonly score: number;
  readonly ariaLabel: string;
  readonly leading: boolean;
}

export interface HudClockModel {
  readonly text: string;
  readonly ariaLabel: string;
  readonly urgent: boolean;
}

export type HudBoostLevel = 'ready' | 'low' | 'critical' | 'unavailable';

export interface HudBoostModel {
  readonly available: boolean;
  readonly value: number;
  readonly gaugePercent: number;
  readonly level: HudBoostLevel;
  readonly ariaValueNow: number | null;
  readonly ariaValueText: string;
}

export interface HudOccupancyModel {
  readonly connected: number;
  readonly totalCapacity: number;
  readonly teamCapacity: number;
  readonly text: string;
  readonly ariaLabel: string;
}

export interface HudCameraModel {
  readonly mode: HudCameraMode | null;
  readonly text: string;
  readonly ariaLabel: string;
}

/** One composite notice derived from exactly one stable authoritative event. */
export interface HudNotice {
  readonly eventId: number;
  readonly centerText: string;
  readonly announcement: string;
}

export interface HudViewModel {
  readonly active: boolean;
  readonly phase: MatchPhase;
  readonly phaseLabel: string;
  readonly blue: HudTeamModel;
  readonly orange: HudTeamModel;
  readonly clock: HudClockModel;
  readonly boost: HudBoostModel;
  readonly occupancy: HudOccupancyModel;
  readonly camera: HudCameraModel;
  /** Text for the screen-centre notice slot; empty when nothing should show. */
  readonly centerText: string;
  /** Non-null only on the frame a new stable event is first observed. */
  readonly announcement: HudNotice | null;
}

const IDLE_CLOCK_TEXT = '5:00';

const UNAVAILABLE_BOOST: HudBoostModel = Object.freeze({
  available: false,
  value: 0,
  gaugePercent: 0,
  level: 'unavailable',
  ariaValueNow: null,
  ariaValueText: 'Boost unavailable',
});

function teamLabel(team: Team): string {
  return team === 'blue' ? 'BLUE' : 'ORANGE';
}

function teamName(team: Team): string {
  return team === 'blue' ? 'Blue' : 'Orange';
}

function finiteScore(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function formatHudClock(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function phaseLabelFor(snapshot: HudSnapshotInput): string {
  switch (snapshot.phase) {
    case 'waiting':
      return 'WAITING FOR PLAYERS';
    case 'countdown':
      if (snapshot.countdownKind === 'post-goal') return 'RESET · KICKOFF';
      if (snapshot.countdownKind === 'overtime') return 'OVERTIME KICKOFF';
      return 'KICKOFF';
    case 'goal-reset':
      return 'GOAL RESET';
    case 'overtime':
      return 'SUDDEN DEATH';
    case 'ended':
      return snapshot.winner ? `${teamLabel(snapshot.winner)} VICTORY` : 'MATCH COMPLETE';
    case 'playing':
    default:
      return snapshot.regulationSecondsRemaining <= 30 ? 'FINAL SECONDS' : 'REGULATION';
  }
}

function clockFor(snapshot: HudSnapshotInput): HudClockModel {
  if (snapshot.phase === 'overtime') {
    return { text: 'OT', ariaLabel: 'Overtime, sudden death', urgent: false };
  }
  if (snapshot.phase === 'ended') {
    return { text: 'FINAL', ariaLabel: 'Match complete', urgent: false };
  }

  const text = formatHudClock(snapshot.regulationSecondsRemaining);
  const urgent = snapshot.phase === 'playing' && snapshot.regulationSecondsRemaining <= 30;
  return { text, ariaLabel: `Time remaining: ${text}`, urgent };
}

/** The continuous phase display; it carries no event identity of its own. */
function phaseDisplayFor(snapshot: HudSnapshotInput): string {
  if (snapshot.phase === 'countdown') {
    const remaining = Number.isFinite(snapshot.phaseSecondsRemaining)
      ? snapshot.phaseSecondsRemaining
      : 0;
    return String(Math.max(1, Math.ceil(remaining)));
  }
  return '';
}

function boostFor(
  snapshot: HudSnapshotInput,
  local: HudLocalPresentation,
): HudBoostModel {
  if (local.localSessionId === null) return UNAVAILABLE_BOOST;
  const car = snapshot.cars.find(({ sessionId }) => sessionId === local.localSessionId);
  if (car === undefined || !Number.isFinite(car.boost)) return UNAVAILABLE_BOOST;

  const clamped = Math.min(100, Math.max(0, car.boost));
  const rounded = Math.round(clamped);
  return {
    available: true,
    value: rounded,
    gaugePercent: clamped,
    level: clamped <= 10 ? 'critical' : clamped <= 25 ? 'low' : 'ready',
    ariaValueNow: rounded,
    ariaValueText: `${rounded} boost`,
  };
}

function occupancyFor(snapshot: HudSnapshotInput): HudOccupancyModel {
  const connected = snapshot.cars.length;
  const totalCapacity = finiteScore(snapshot.totalCapacity);
  const teamCapacity = finiteScore(snapshot.teamCapacity);
  return {
    connected,
    totalCapacity,
    teamCapacity,
    text: `${connected}/${totalCapacity}`,
    ariaLabel: `${connected} of ${totalCapacity} players connected,`
      + ` ${teamCapacity} per team, ${snapshot.roomMode} match`,
  };
}

function cameraFor(local: HudLocalPresentation): HudCameraModel {
  switch (local.cameraMode) {
    case 'ball':
      return { mode: 'ball', text: 'BALL CAM', ariaLabel: 'Camera: ball cam' };
    case 'car':
      return { mode: 'car', text: 'CAR CAM', ariaLabel: 'Camera: car cam' };
    case 'orbit':
      return { mode: 'orbit', text: 'ORBIT', ariaLabel: 'Camera: orbit' };
    default:
      return { mode: null, text: '', ariaLabel: 'Camera: unavailable' };
  }
}

function scoreLine(blueScore: number, orangeScore: number): string {
  return `Blue ${blueScore}, Orange ${orangeScore}`;
}

/**
 * Build one composite notice for a stable transition. Missing optional detail
 * yields null so the HUD falls back to its stable phase display instead of
 * blocking or inventing an outcome.
 */
function noticeFor(transition: Readonly<MatchTransitionSnapshot>): HudNotice | null {
  const { eventId, kind, goal, terminal } = transition;
  if (!Number.isFinite(eventId)) return null;

  switch (kind) {
    case 'regulation-goal-reset': {
      if (goal === null) return null;
      const label = teamLabel(goal.team);
      return {
        eventId,
        centerText: `${label} GOAL · ${goal.blueScore} — ${goal.orangeScore}`,
        announcement: `${teamName(goal.team)} goal.`
          + ` ${scoreLine(goal.blueScore, goal.orangeScore)}.`,
      };
    }
    case 'regulation-terminal-goal':
    case 'overtime-terminal-goal': {
      if (terminal === null) return null;
      const label = teamLabel(terminal.winner);
      return {
        eventId,
        centerText: `${label} WINS · ${terminal.blueScore} — ${terminal.orangeScore}`,
        announcement: `${teamName(terminal.winner)} wins.`
          + ` ${scoreLine(terminal.blueScore, terminal.orangeScore)}.`,
      };
    }
    case 'hard-cutoff': {
      if (terminal === null) return null;
      const label = teamLabel(terminal.winner);
      return {
        eventId,
        centerText: `FULL TIME · ${label} WINS`,
        announcement: `Full time. ${teamName(terminal.winner)} wins.`
          + ` ${scoreLine(terminal.blueScore, terminal.orangeScore)}.`,
      };
    }
    case 'overtime-entry':
      return {
        eventId,
        centerText: 'OVERTIME',
        announcement: 'Overtime. Next goal wins.',
      };
    case 'countdown':
    default:
      return null;
  }
}

/**
 * Projects accepted snapshots into one HUD view model and guarantees that each
 * stable authoritative event produces exactly one notice and one announcement,
 * however many times the same snapshot is projected.
 */
export class HudModel {
  #consumedEventId: number | null = null;
  #heldNotice: HudNotice | null = null;

  /** Forget every consumed event; used when a room is left or replaced. */
  reset(): void {
    this.#consumedEventId = null;
    this.#heldNotice = null;
  }

  /** The notice currently occupying the centre slot, if any. */
  get heldNotice(): HudNotice | null {
    return this.#heldNotice;
  }

  idle(local: HudLocalPresentation = { localSessionId: null, cameraMode: null }): HudViewModel {
    return {
      active: false,
      phase: 'waiting',
      phaseLabel: 'WAITING',
      blue: {
        team: 'blue',
        label: 'BLUE',
        score: 0,
        ariaLabel: 'Blue score: 0',
        leading: false,
      },
      orange: {
        team: 'orange',
        label: 'ORANGE',
        score: 0,
        ariaLabel: 'Orange score: 0',
        leading: false,
      },
      clock: { text: IDLE_CLOCK_TEXT, ariaLabel: 'Match not started', urgent: false },
      boost: UNAVAILABLE_BOOST,
      occupancy: {
        connected: 0,
        totalCapacity: 0,
        teamCapacity: 0,
        text: '',
        ariaLabel: 'No room joined',
      },
      camera: cameraFor(local),
      centerText: '',
      announcement: null,
    };
  }

  project(snapshot: HudSnapshotInput, local: HudLocalPresentation): HudViewModel {
    const blueScore = finiteScore(snapshot.blueScore);
    const orangeScore = finiteScore(snapshot.orangeScore);

    let announcement: HudNotice | null = null;
    const transition = snapshot.latestTransition;
    if (transition !== null && transition.eventId !== this.#consumedEventId) {
      this.#consumedEventId = transition.eventId;
      const notice = noticeFor(transition);
      if (notice !== null) {
        this.#heldNotice = notice;
        announcement = notice;
      }
    }

    const phaseDisplay = phaseDisplayFor(snapshot);
    // The phase display always wins once it has something to say, which
    // naturally retires a goal notice when the next kickoff starts counting.
    if (phaseDisplay.length > 0) this.#heldNotice = null;

    return {
      active: true,
      phase: snapshot.phase,
      phaseLabel: phaseLabelFor(snapshot),
      blue: {
        team: 'blue',
        label: 'BLUE',
        score: blueScore,
        ariaLabel: `Blue score: ${blueScore}`,
        leading: blueScore > orangeScore,
      },
      orange: {
        team: 'orange',
        label: 'ORANGE',
        score: orangeScore,
        ariaLabel: `Orange score: ${orangeScore}`,
        leading: orangeScore > blueScore,
      },
      clock: clockFor(snapshot),
      boost: boostFor(snapshot, local),
      occupancy: occupancyFor(snapshot),
      camera: cameraFor(local),
      centerText: phaseDisplay.length > 0 ? phaseDisplay : this.#heldNotice?.centerText ?? '',
      announcement,
    };
  }
}
