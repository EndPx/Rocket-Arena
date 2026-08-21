import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGoalResult,
  createTerminalResult,
  type GoalResult,
  type MatchTransitionSnapshot,
  type TerminalResult,
} from '@rocket-arena/shared';
import {
  HUD_CONTROL_HINTS,
  HudModel,
  formatHudClock,
  type HudLocalPresentation,
  type HudSnapshotInput,
} from '../src/hud/hud-model.js';
import { GAMEPLAY_CODES } from '../src/input/input-controller.js';

const LOCAL_ID = 'local-driver';

function local(overrides: Partial<HudLocalPresentation> = {}): HudLocalPresentation {
  return { localSessionId: LOCAL_ID, cameraMode: 'car', ...overrides };
}

function snapshot(overrides: Partial<HudSnapshotInput> = {}): HudSnapshotInput {
  return {
    phase: 'playing',
    countdownKind: null,
    blueScore: 0,
    orangeScore: 0,
    regulationSecondsRemaining: 300,
    phaseSecondsRemaining: 300,
    winner: null,
    roomMode: 'custom',
    totalCapacity: 8,
    teamCapacity: 4,
    latestTransition: null,
    cars: [
      { sessionId: LOCAL_ID, team: 'blue', boost: 33 },
      { sessionId: 'rival', team: 'orange', boost: 71 },
    ],
    ...overrides,
  };
}

function goal(eventId: number, blueScore: number, orangeScore: number): Readonly<GoalResult> {
  return createGoalResult({
    eventId,
    team: blueScore > orangeScore ? 'blue' : 'orange',
    kickoffEpoch: eventId + 1,
    blueScore,
    orangeScore,
  });
}

function terminal(
  eventId: number,
  reason: TerminalResult['reason'],
  blueScore: number,
  orangeScore: number,
): Readonly<TerminalResult> {
  return createTerminalResult({
    eventId,
    reason,
    winner: blueScore > orangeScore ? 'blue' : 'orange',
    blueScore,
    orangeScore,
    goal: reason === 'hard-regulation-cutoff' ? null : goal(eventId, blueScore, orangeScore),
  });
}

function transition(
  eventId: number,
  kind: MatchTransitionSnapshot['kind'],
  detail: Partial<Pick<MatchTransitionSnapshot, 'goal' | 'terminal'>> = {},
): Readonly<MatchTransitionSnapshot> {
  return Object.freeze({
    eventId,
    kind,
    goal: detail.goal ?? null,
    terminal: detail.terminal ?? null,
  });
}

// Validates: Requirements 16.1-16.20 (Task 9 accepted-state HUD projection)

test('each stable event produces exactly one notice and one announcement', () => {
  const model = new HudModel();
  const scored = snapshot({
    phase: 'goal-reset',
    blueScore: 1,
    orangeScore: 0,
    latestTransition: transition(7, 'regulation-goal-reset', { goal: goal(7, 1, 0) }),
  });

  const first = model.project(scored, local());
  assert.ok(first.announcement, 'the first observation announces the event');
  assert.equal(first.announcement.eventId, 7);
  assert.match(first.announcement.centerText, /BLUE GOAL/);
  assert.match(first.announcement.centerText, /1 — 0/);
  assert.equal(first.announcement.announcement, 'Blue goal. Blue 1, Orange 0.');
  assert.equal(first.centerText, first.announcement.centerText);

  for (let repeat = 0; repeat < 5; repeat++) {
    const again = model.project(scored, local());
    assert.equal(again.announcement, null, 'a repeated snapshot must not announce again');
    assert.equal(again.centerText, first.announcement.centerText, 'the notice stays visible');
  }

  const nextEvent = model.project(
    snapshot({
      phase: 'goal-reset',
      blueScore: 1,
      orangeScore: 1,
      latestTransition: transition(8, 'regulation-goal-reset', { goal: goal(8, 1, 1) }),
    }),
    local(),
  );
  assert.ok(nextEvent.announcement);
  assert.equal(nextEvent.announcement.eventId, 8);
  assert.match(nextEvent.announcement.centerText, /ORANGE GOAL/);
});

test('terminal, cutoff, and overtime transitions announce their composite outcome', () => {
  const regulationWin = new HudModel().project(
    snapshot({
      phase: 'ended',
      blueScore: 3,
      orangeScore: 1,
      winner: 'blue',
      latestTransition: transition(11, 'regulation-terminal-goal', {
        goal: goal(11, 3, 1),
        terminal: terminal(11, 'regulation-target-and-margin', 3, 1),
      }),
    }),
    local(),
  );
  assert.ok(regulationWin.announcement);
  assert.match(regulationWin.announcement.centerText, /BLUE WINS · 3 — 1/);
  assert.equal(regulationWin.announcement.announcement, 'Blue wins. Blue 3, Orange 1.');
  assert.equal(regulationWin.clock.text, 'FINAL');

  const cutoff = new HudModel().project(
    snapshot({
      phase: 'ended',
      blueScore: 2,
      orangeScore: 4,
      winner: 'orange',
      latestTransition: transition(12, 'hard-cutoff', {
        terminal: terminal(12, 'hard-regulation-cutoff', 2, 4),
      }),
    }),
    local(),
  );
  assert.ok(cutoff.announcement);
  assert.match(cutoff.announcement.centerText, /FULL TIME · ORANGE WINS/);

  const overtime = new HudModel().project(
    snapshot({
      phase: 'overtime',
      blueScore: 2,
      orangeScore: 2,
      latestTransition: transition(13, 'overtime-entry'),
    }),
    local(),
  );
  assert.ok(overtime.announcement);
  assert.equal(overtime.announcement.centerText, 'OVERTIME');
  assert.equal(overtime.clock.text, 'OT');
  assert.equal(overtime.phaseLabel, 'SUDDEN DEATH');
});

test('missing optional transition detail degrades to the stable phase display', () => {
  const model = new HudModel();
  const view = model.project(
    snapshot({
      phase: 'goal-reset',
      blueScore: 1,
      orangeScore: 0,
      // A goal-reset transition without its goal payload carries no outcome.
      latestTransition: transition(21, 'regulation-goal-reset'),
    }),
    local(),
  );

  assert.equal(view.announcement, null);
  assert.equal(view.centerText, '');
  assert.equal(view.phaseLabel, 'GOAL RESET');
  assert.equal(view.blue.score, 1, 'the accepted score still renders');
  assert.equal(view.active, true, 'the HUD must not be blocked by missing detail');

  const countdownOnly = model.project(
    snapshot({ phase: 'countdown', countdownKind: 'post-goal', phaseSecondsRemaining: 2.4 }),
    local(),
  );
  assert.equal(countdownOnly.centerText, '3');
  assert.equal(countdownOnly.phaseLabel, 'RESET · KICKOFF');
});

test('a countdown retires a held goal notice', () => {
  const model = new HudModel();
  const scored = model.project(
    snapshot({
      phase: 'goal-reset',
      blueScore: 0,
      orangeScore: 1,
      latestTransition: transition(31, 'regulation-goal-reset', { goal: goal(31, 0, 1) }),
    }),
    local(),
  );
  assert.match(scored.centerText, /ORANGE GOAL/);
  assert.ok(model.heldNotice);

  const counting = model.project(
    snapshot({
      phase: 'countdown',
      countdownKind: 'post-goal',
      phaseSecondsRemaining: 1.2,
      blueScore: 0,
      orangeScore: 1,
      latestTransition: transition(31, 'regulation-goal-reset', { goal: goal(31, 0, 1) }),
    }),
    local(),
  );
  assert.equal(counting.centerText, '2');
  assert.equal(model.heldNotice, null);
});

test('reset forgets consumed events so a new room can announce again', () => {
  const model = new HudModel();
  const scored = snapshot({
    phase: 'goal-reset',
    blueScore: 1,
    orangeScore: 0,
    latestTransition: transition(41, 'regulation-goal-reset', { goal: goal(41, 1, 0) }),
  });

  assert.ok(model.project(scored, local()).announcement);
  assert.equal(model.project(scored, local()).announcement, null);
  model.reset();
  assert.ok(model.project(scored, local()).announcement, 'a fresh room re-announces');
});

test('boost projection is clamped, levelled, and accessible', () => {
  const model = new HudModel();

  const ready = model.project(snapshot(), local()).boost;
  assert.equal(ready.available, true);
  assert.equal(ready.value, 33);
  assert.equal(ready.level, 'ready');
  assert.equal(ready.ariaValueNow, 33);
  assert.equal(ready.ariaValueText, '33 boost');

  const low = model.project(
    snapshot({ cars: [{ sessionId: LOCAL_ID, team: 'blue', boost: 18 }] }),
    local(),
  ).boost;
  assert.equal(low.level, 'low');

  const critical = model.project(
    snapshot({ cars: [{ sessionId: LOCAL_ID, team: 'blue', boost: 4 }] }),
    local(),
  ).boost;
  assert.equal(critical.level, 'critical');

  const overflow = model.project(
    snapshot({ cars: [{ sessionId: LOCAL_ID, team: 'blue', boost: 250 }] }),
    local(),
  ).boost;
  assert.equal(overflow.value, 100);
  assert.equal(overflow.gaugePercent, 100);

  const negative = model.project(
    snapshot({ cars: [{ sessionId: LOCAL_ID, team: 'blue', boost: -12 }] }),
    local(),
  ).boost;
  assert.equal(negative.value, 0);

  const nonFinite = model.project(
    snapshot({ cars: [{ sessionId: LOCAL_ID, team: 'blue', boost: Number.NaN }] }),
    local(),
  ).boost;
  assert.equal(nonFinite.available, false);
  assert.equal(nonFinite.ariaValueNow, null);
  assert.equal(nonFinite.ariaValueText, 'Boost unavailable');

  const spectating = model.project(snapshot(), local({ localSessionId: null })).boost;
  assert.equal(spectating.available, false);

  const notPresent = model.project(
    snapshot({ cars: [{ sessionId: 'rival', team: 'orange', boost: 50 }] }),
    local(),
  ).boost;
  assert.equal(notPresent.available, false);
});

test('capacity, camera, clock, and team identity are exposed accessibly', () => {
  const model = new HudModel();

  const view = model.project(snapshot(), local());
  assert.equal(view.occupancy.connected, 2);
  assert.equal(view.occupancy.totalCapacity, 8);
  assert.equal(view.occupancy.teamCapacity, 4);
  assert.equal(view.occupancy.text, '2/8');
  assert.match(view.occupancy.ariaLabel, /2 of 8 players connected/);
  assert.match(view.occupancy.ariaLabel, /4 per team/);
  assert.match(view.occupancy.ariaLabel, /custom match/);

  assert.equal(view.camera.text, 'CAR CAM');
  assert.equal(view.camera.ariaLabel, 'Camera: car cam');
  assert.equal(model.project(snapshot(), local({ cameraMode: 'ball' })).camera.text, 'BALL CAM');
  assert.equal(model.project(snapshot(), local({ cameraMode: 'orbit' })).camera.text, 'ORBIT');
  const noCamera = model.project(snapshot(), local({ cameraMode: null })).camera;
  assert.equal(noCamera.text, '');
  assert.equal(noCamera.ariaLabel, 'Camera: unavailable');

  // Blue and Orange are named in text, not only coloured.
  assert.equal(view.blue.label, 'BLUE');
  assert.equal(view.orange.label, 'ORANGE');
  assert.equal(view.blue.ariaLabel, 'Blue score: 0');
  assert.equal(view.orange.ariaLabel, 'Orange score: 0');
  assert.equal(view.blue.leading, false);
  assert.equal(view.orange.leading, false);

  const leading = model.project(snapshot({ blueScore: 2, orangeScore: 1 }), local());
  assert.equal(leading.blue.leading, true);
  assert.equal(leading.orange.leading, false);

  const urgent = model.project(snapshot({ regulationSecondsRemaining: 12 }), local());
  assert.equal(urgent.clock.text, '0:12');
  assert.equal(urgent.clock.urgent, true);
  assert.equal(urgent.phaseLabel, 'FINAL SECONDS');
  assert.equal(urgent.clock.ariaLabel, 'Time remaining: 0:12');

  const calm = model.project(snapshot({ regulationSecondsRemaining: 296.4 }), local());
  assert.equal(calm.clock.text, '4:57');
  assert.equal(calm.clock.urgent, false);
  assert.equal(calm.phaseLabel, 'REGULATION');

  const waiting = model.project(snapshot({ phase: 'waiting' }), local());
  assert.equal(waiting.phaseLabel, 'WAITING FOR PLAYERS');
});

test('the idle view is inactive and exposes nothing authoritative', () => {
  const view = new HudModel().idle();
  assert.equal(view.active, false);
  assert.equal(view.blue.score, 0);
  assert.equal(view.orange.score, 0);
  assert.equal(view.clock.text, '5:00');
  assert.equal(view.clock.ariaLabel, 'Match not started');
  assert.equal(view.boost.available, false);
  assert.equal(view.occupancy.text, '');
  assert.equal(view.occupancy.ariaLabel, 'No room joined');
  assert.equal(view.centerText, '');
  assert.equal(view.announcement, null);
});

test('clock formatting stays finite and non-negative', () => {
  assert.equal(formatHudClock(0), '0:00');
  assert.equal(formatHudClock(-40), '0:00');
  assert.equal(formatHudClock(Number.NaN), '0:00');
  assert.equal(formatHudClock(Number.POSITIVE_INFINITY), '0:00');
  assert.equal(formatHudClock(59.2), '1:00');
  assert.equal(formatHudClock(300), '5:00');
});

test('the on-screen control reference matches the real gameplay bindings', () => {
  assert.ok(HUD_CONTROL_HINTS.length > 0);

  const claimed = new Set<string>();
  for (const hint of HUD_CONTROL_HINTS) {
    assert.ok(hint.keys.length > 0, `${hint.action} must paint at least one key cap`);
    assert.ok(hint.codes.length > 0, `${hint.action} must name the codes it stands for`);
    assert.ok(hint.action.length > 0);
    // Every row carries its own accessible name; the painted caps are decorative.
    assert.match(hint.ariaLabel, /: /, `${hint.action} needs a "key: meaning" label`);

    for (const code of hint.codes) {
      assert.ok(
        GAMEPLAY_CODES.has(code),
        `the reference claims ${code}, which the input controller ignores`,
      );
      assert.equal(claimed.has(code), false, `${code} is listed twice`);
      claimed.add(code);
    }
  }

  // Arrow keys are deliberately unlisted because they duplicate WASD. Every
  // other gameplay code must be discoverable on screen.
  const arrowCodes = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  for (const code of GAMEPLAY_CODES) {
    if (arrowCodes.includes(code)) continue;
    assert.ok(claimed.has(code), `${code} is a gameplay binding with no on-screen hint`);
  }
  for (const code of arrowCodes) {
    assert.equal(claimed.has(code), false, 'arrow keys stay unlisted as WASD duplicates');
  }
});
