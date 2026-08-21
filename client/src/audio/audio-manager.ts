import * as THREE from 'three';
import { AUDIO, type InputPayload } from '@rocket-arena/shared';
import type { StateEntity, StateSync } from '../networking/state-listener.js';
import {
  AudioEventTracker,
  AudioTransitionQueue,
  calculateStereoPan,
  clamp,
  dampValue,
  isGameplayPhase,
  isQueueableTransition,
  normalizeVolume,
  parseAudioSettings,
  speedToEngineTargets,
  type AudioEventType,
  type AudioSettings,
  type KinematicAudioCar,
  type KinematicAudioEntity,
  type TrackedAudioEvent,
  type Vector3Like,
} from './audio-model.js';

const AUDIO_SETTINGS_STORAGE_KEY = 'rocket-arena-audio-settings-v1';
const AUDIO_CONTROL_ID = 'rocket-audio-control';
const AUDIO_CONTROL_STYLE_ID = 'rocket-audio-control-style';

const EVENT_TYPES: readonly AudioEventType[] = [
  'jump',
  'landing',
  'impact',
  'countdown',
  'go',
  'goal',
  'overtime',
  'match-end',
  'ui',
];

interface AudioContextWindow extends Window {
  AudioContext?: typeof globalThis.AudioContext;
  webkitAudioContext?: typeof globalThis.AudioContext;
}

interface AudioGraph {
  context: AudioContext;
  limiter: DynamicsCompressorNode;
  masterGain: GainNode;
  noiseBuffer: AudioBuffer;
}

interface ContinuousGraph {
  enginePrimary: OscillatorNode;
  engineHarmonic: OscillatorNode;
  enginePrimaryMix: GainNode;
  engineHarmonicMix: GainNode;
  engineFilter: BiquadFilterNode;
  engineGain: GainNode;
  boostSource: AudioBufferSourceNode;
  boostFilter: BiquadFilterNode;
  boostGain: GainNode;
}

interface OneShotVoice {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
}

export interface AudioFrame {
  roomId: string | null;
  sessionId: string | null;
  state: StateSync | null;
  input: Readonly<InputPayload>;
  localCar: THREE.Group | null;
  ball: THREE.Group | null;
  camera: THREE.Camera;
  deltaSeconds: number;
  nowMs: number;
}

export interface AudioDebugState {
  supported: boolean;
  initialized: boolean;
  contextState: string;
  muted: boolean;
  volume: number;
  roomId: string | null;
  phase: string | null;
  activeContinuousLayers: {
    engine: boolean;
    boost: boolean;
  };
  eventPlayCounts: Record<AudioEventType, number>;
  trackedSequence: number | null;
  queuedTransitionCount: number;
  liveOneShotVoiceCount: number;
  continuousGraphCount: 0 | 1;
}

declare global {
  interface Window {
    __rocketArenaAudio?: Readonly<{
      getState: () => AudioDebugState;
    }>;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

function readSettings(): AudioSettings {
  if (typeof localStorage === 'undefined') return parseAudioSettings(null);

  try {
    return parseAudioSettings(localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY));
  } catch {
    return parseAudioSettings(null);
  }
}

function toKinematicEntity(entity: StateEntity | null | undefined): KinematicAudioEntity | null {
  if (!entity) return null;
  return {
    x: entity.x,
    y: entity.y,
    z: entity.z,
    vx: entity.vx,
    vy: entity.vy,
    vz: entity.vz,
  };
}

function toKinematicCar(
  id: string,
  entity: StateEntity | null | undefined,
): KinematicAudioCar | null {
  const kinematics = toKinematicEntity(entity);
  return kinematics ? { id, ...kinematics } : null;
}

function createEventCounts(): Record<AudioEventType, number> {
  return Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<AudioEventType, number>;
}

class ProceduralAudioManager {
  private readonly tracker = new AudioEventTracker();
  private readonly transitionQueue = new AudioTransitionQueue();
  private readonly cameraRight = new THREE.Vector3();
  private readonly eventPlayCounts = createEventCounts();
  private readonly oneShotVoices = new Set<OneShotVoice>();
  private initialized = false;
  private destroyed = false;
  private graph: AudioGraph | null = null;
  private continuous: ContinuousGraph | null = null;
  private roomId: string | null = null;
  private sessionId: string | null = null;
  private phase: string | null = null;
  private hadState = false;
  private lastObservedSequence: number | null = null;
  private suppressNextSnapshotEvents = false;
  private muted: boolean;
  private volume: number;
  private smoothedEngineFrequency: number = AUDIO.ENGINE.IDLE_FREQUENCY_HZ;
  private smoothedEngineFilter: number = AUDIO.ENGINE.FILTER_MIN_HZ;
  private smoothedEngineGain: number = 0;
  private smoothedBoostGain: number = 0;
  private engineActive = false;
  private boostActive = false;
  private control: HTMLElement | null = null;
  private controlStyle: HTMLStyleElement | null = null;
  private muteButton: HTMLButtonElement | null = null;
  private volumeInput: HTMLInputElement | null = null;
  private volumeOutput: HTMLOutputElement | null = null;
  private warnedAboutContext = false;

  constructor() {
    const settings = readSettings();
    this.muted = settings.muted;
    this.volume = settings.volume;
  }

  initialize(): void {
    if (this.initialized || this.destroyed || typeof window === 'undefined') return;
    this.initialized = true;
    this.createControl();

    window.addEventListener('pointerdown', this.handlePointerGesture, { capture: true, passive: true });
    window.addEventListener('keydown', this.handleKeyboardGesture, { capture: true });
    document.addEventListener('click', this.handleDelegatedButtonClick);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('pageshow', this.handlePageShow);

    window.__rocketArenaAudio = Object.freeze({
      getState: () => this.getDebugState(),
    });
  }

  update(frame: AudioFrame): void {
    if (!this.initialized || this.destroyed) return;

    const identityChanged = (
      frame.roomId !== this.roomId
      || frame.sessionId !== this.sessionId
    );
    const stateLost = this.hadState && frame.state === null;
    if (identityChanged || stateLost) {
      this.resetSessionBoundary(frame.roomId, frame.sessionId);
    }

    this.roomId = frame.roomId;
    this.sessionId = frame.sessionId;
    this.hadState = frame.state !== null;
    this.phase = frame.state?.phase ?? null;

    const localState = frame.state && frame.sessionId
      ? frame.state.players[frame.sessionId] ?? null
      : null;
    const gameplayActive = frame.roomId !== null
      && frame.state !== null
      && localState !== null
      && isGameplayPhase(frame.state.phase)
      && !document.hidden;

    this.tracker.observeJump(frame.input.jumpSequence, gameplayActive, frame.nowMs);

    if (
      frame.state
      && frame.sessionId
      && frame.state.sequence !== this.lastObservedSequence
    ) {
      const localCar = toKinematicCar(frame.sessionId, localState);
      const otherCars = Object.entries(frame.state.players)
        .filter(([sessionId]) => sessionId !== frame.sessionId)
        .map(([sessionId, player]) => toKinematicCar(sessionId, player))
        .filter((player): player is KinematicAudioCar => player !== null);
      const events = this.tracker.observeSnapshot({
        sequence: frame.state.sequence,
        phase: frame.state.phase,
        blueScore: frame.state.blueScore,
        orangeScore: frame.state.orangeScore,
        timeRemaining: frame.state.timeRemaining,
        localCar,
        ball: toKinematicEntity(frame.state.ball),
        otherCars,
      }, frame.nowMs);
      this.lastObservedSequence = frame.state.sequence;

      const suppressEvents = document.hidden || this.suppressNextSnapshotEvents;
      if (!document.hidden && this.suppressNextSnapshotEvents) {
        this.suppressNextSnapshotEvents = false;
      }
      if (!suppressEvents) {
        for (const event of events) this.dispatchEvent(event, frame.camera);
      }
    }

    this.updateContinuousLayers(frame, gameplayActive);
  }

  getDebugState(): AudioDebugState {
    const trackerState = this.tracker.getDebugState();
    return {
      supported: this.getContextConstructor() !== null,
      initialized: this.initialized,
      contextState: this.graph?.context.state ?? 'not-created',
      muted: this.muted,
      volume: this.volume,
      roomId: this.roomId,
      phase: this.phase,
      activeContinuousLayers: {
        engine: this.engineActive,
        boost: this.boostActive,
      },
      eventPlayCounts: { ...this.eventPlayCounts },
      trackedSequence: trackerState.lastSequence,
      queuedTransitionCount: this.transitionQueue.size,
      liveOneShotVoiceCount: this.oneShotVoices.size,
      continuousGraphCount: this.continuous ? 1 : 0,
    };
  }

  cleanup(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initialized = false;

    window.removeEventListener('pointerdown', this.handlePointerGesture, { capture: true });
    window.removeEventListener('keydown', this.handleKeyboardGesture, { capture: true });
    document.removeEventListener('click', this.handleDelegatedButtonClick);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('pagehide', this.handlePageHide);
    window.removeEventListener('pageshow', this.handlePageShow);

    this.transitionQueue.clear();
    this.disposeAudioGraph(true);

    this.muteButton?.removeEventListener('click', this.handleMuteButtonClick);
    this.volumeInput?.removeEventListener('input', this.handleVolumeInput);
    this.control?.remove();
    this.controlStyle?.remove();
    this.control = null;
    this.controlStyle = null;
    this.muteButton = null;
    this.volumeInput = null;
    this.volumeOutput = null;
    this.tracker.reset();
    this.roomId = null;
    this.sessionId = null;
    this.phase = null;
    this.hadState = false;
    this.lastObservedSequence = null;
    this.suppressNextSnapshotEvents = false;
    this.engineActive = false;
    this.boostActive = false;

    if (window.__rocketArenaAudio) delete window.__rocketArenaAudio;
  }

  private readonly handlePointerGesture = (event: PointerEvent): void => {
    if (event.isTrusted) void this.unlock();
  };

  private readonly handleKeyboardGesture = (event: KeyboardEvent): void => {
    if (event.isTrusted && !event.repeat && !isEditableTarget(event.target)) {
      void this.unlock();
    }
  };

  private readonly handleDelegatedButtonClick = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    void this.unlock().then(() => {
      if (!this.muted) this.playEvent({ type: 'ui', strength: 1 }, null);
    });
  };

  private readonly handleMuteButtonClick = (): void => {
    this.setMuted(!this.muted);
  };

  private readonly handleVolumeInput = (): void => {
    this.setVolume(Number(this.volumeInput?.value));
  };

  private readonly handleVisibilityChange = (): void => {
    this.transitionQueue.clear();
    this.tracker.resetMotionHistory();
    this.suppressNextSnapshotEvents = true;
    if (document.hidden) {
      this.stopOneShots();
      this.fadeContinuousLayers();
    }
  };

  private readonly handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      this.resetSessionBoundary(null, null);
      this.suppressNextSnapshotEvents = true;
      return;
    }
    this.cleanup();
  };

  private readonly handlePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted || this.destroyed) return;
    this.resetSessionBoundary(null, null);
    this.suppressNextSnapshotEvents = true;
  };

  private async unlock(): Promise<void> {
    if (this.destroyed) return;
    try {
      if (!this.graph || this.graph.context.state === 'closed') this.createAudioGraph();
      const context = this.graph?.context;
      if (context && context.state !== 'running') await context.resume();
      if (context?.state === 'running') this.flushQueuedTransitions();
    } catch (error) {
      this.fadeContinuousLayers();
      if (!this.warnedAboutContext) {
        this.warnedAboutContext = true;
        console.warn('[Audio] Web Audio unavailable; continuing silently.', error);
      }
    }
  }

  private getContextConstructor(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null;
    const audioWindow = window as AudioContextWindow;
    return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
  }

  private createAudioGraph(): void {
    const AudioContextConstructor = this.getContextConstructor();
    if (!AudioContextConstructor) return;

    if (this.graph || this.continuous || this.oneShotVoices.size > 0) {
      this.disposeAudioGraph(true);
    }

    let context: AudioContext | null = null;
    let limiter: DynamicsCompressorNode | null = null;
    let masterGain: GainNode | null = null;
    try {
      context = new AudioContextConstructor({ latencyHint: 'interactive' });
      limiter = context.createDynamicsCompressor();
      limiter.threshold.value = AUDIO.MASTER.LIMITER_THRESHOLD_DB;
      limiter.knee.value = AUDIO.MASTER.LIMITER_KNEE_DB;
      limiter.ratio.value = AUDIO.MASTER.LIMITER_RATIO;
      limiter.attack.value = AUDIO.MASTER.LIMITER_ATTACK_SECONDS;
      limiter.release.value = AUDIO.MASTER.LIMITER_RELEASE_SECONDS;

      masterGain = context.createGain();
      masterGain.gain.value = this.effectiveMasterGain();
      limiter.connect(masterGain);
      masterGain.connect(context.destination);

      const noiseBuffer = context.createBuffer(
        1,
        Math.max(1, Math.floor(context.sampleRate * AUDIO.BOOST.NOISE_BUFFER_SECONDS)),
        context.sampleRate,
      );
      const samples = noiseBuffer.getChannelData(0);
      for (let index = 0; index < samples.length; index++) {
        samples[index] = Math.random() * 2 - 1;
      }

      this.graph = { context, limiter, masterGain, noiseBuffer };
      this.createContinuousGraph();
    } catch (error) {
      if (context && this.graph?.context === context) {
        this.disposeAudioGraph(true);
      } else {
        this.disconnectNode(limiter);
        this.disconnectNode(masterGain);
        if (context && context.state !== 'closed') {
          void context.close().catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private createContinuousGraph(): void {
    const graph = this.graph;
    if (!graph || this.continuous) return;
    const { context, limiter, noiseBuffer } = graph;

    const enginePrimary = context.createOscillator();
    enginePrimary.type = 'sawtooth';
    enginePrimary.frequency.value = AUDIO.ENGINE.IDLE_FREQUENCY_HZ;
    const engineHarmonic = context.createOscillator();
    engineHarmonic.type = 'square';
    engineHarmonic.frequency.value = AUDIO.ENGINE.IDLE_FREQUENCY_HZ * AUDIO.ENGINE.HARMONIC_RATIO;
    const enginePrimaryMix = context.createGain();
    enginePrimaryMix.gain.value = AUDIO.ENGINE.PRIMARY_MIX;
    const engineHarmonicMix = context.createGain();
    engineHarmonicMix.gain.value = AUDIO.ENGINE.HARMONIC_MIX;
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = AUDIO.ENGINE.FILTER_MIN_HZ;
    engineFilter.Q.value = AUDIO.ENGINE.FILTER_Q;
    const engineGain = context.createGain();
    engineGain.gain.value = 0;

    enginePrimary.connect(enginePrimaryMix);
    enginePrimaryMix.connect(engineFilter);
    engineHarmonic.connect(engineHarmonicMix);
    engineHarmonicMix.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(limiter);

    const boostSource = context.createBufferSource();
    boostSource.buffer = noiseBuffer;
    boostSource.loop = true;
    const boostFilter = context.createBiquadFilter();
    boostFilter.type = 'bandpass';
    boostFilter.frequency.value = AUDIO.BOOST.FILTER_FREQUENCY_HZ;
    boostFilter.Q.value = AUDIO.BOOST.FILTER_Q;
    const boostGain = context.createGain();
    boostGain.gain.value = 0;
    boostSource.connect(boostFilter);
    boostFilter.connect(boostGain);
    boostGain.connect(limiter);

    this.continuous = {
      enginePrimary,
      engineHarmonic,
      enginePrimaryMix,
      engineHarmonicMix,
      engineFilter,
      engineGain,
      boostSource,
      boostFilter,
      boostGain,
    };
    try {
      enginePrimary.start();
      engineHarmonic.start();
      boostSource.start();
    } catch (error) {
      this.disposeContinuousGraph();
      throw error;
    }
  }

  private updateContinuousLayers(frame: AudioFrame, gameplayActive: boolean): void {
    const graph = this.graph;
    const continuous = this.continuous;
    const localPlayer = frame.state && frame.sessionId
      ? frame.state.players[frame.sessionId]
      : null;
    const meshSpeed = frame.localCar?.userData.syncedSpeed;
    const fallbackSpeed = localPlayer
      ? Math.hypot(localPlayer.vx, localPlayer.vy, localPlayer.vz)
      : 0;
    const speed = typeof meshSpeed === 'number' && Number.isFinite(meshSpeed)
      ? meshSpeed
      : fallbackSpeed;
    const targets = speedToEngineTargets(speed, frame.input.throttle);
    const boostRequested = gameplayActive
      && frame.input.boost
      && (localPlayer?.boost ?? 0) > 0;
    this.smoothedEngineFrequency = dampValue(
      this.smoothedEngineFrequency,
      targets.frequencyHz,
      AUDIO.ENGINE.RESPONSE,
      frame.deltaSeconds,
    );
    this.smoothedEngineFilter = dampValue(
      this.smoothedEngineFilter,
      targets.filterHz,
      AUDIO.ENGINE.RESPONSE,
      frame.deltaSeconds,
    );
    this.smoothedEngineGain = dampValue(
      this.smoothedEngineGain,
      gameplayActive ? targets.gain : 0,
      AUDIO.ENGINE.RESPONSE,
      frame.deltaSeconds,
    );
    this.smoothedBoostGain = dampValue(
      this.smoothedBoostGain,
      boostRequested ? AUDIO.BOOST.GAIN : 0,
      AUDIO.BOOST.RESPONSE,
      frame.deltaSeconds,
    );

    const contextRunning = graph?.context.state === 'running';
    this.engineActive = Boolean(
      gameplayActive
      && contextRunning
      && !this.muted
      && this.volume > 0
      && this.smoothedEngineGain > AUDIO.MASTER.ACTIVE_GAIN_THRESHOLD,
    );
    this.boostActive = Boolean(
      boostRequested
      && contextRunning
      && !this.muted
      && this.volume > 0
      && this.smoothedBoostGain > AUDIO.MASTER.ACTIVE_GAIN_THRESHOLD,
    );

    if (!graph || !continuous) return;
    const now = graph.context.currentTime;
    continuous.enginePrimary.frequency.setValueAtTime(this.smoothedEngineFrequency, now);
    continuous.engineHarmonic.frequency.setValueAtTime(
      this.smoothedEngineFrequency * AUDIO.ENGINE.HARMONIC_RATIO,
      now,
    );
    continuous.engineFilter.frequency.setValueAtTime(this.smoothedEngineFilter, now);
    continuous.engineGain.gain.setValueAtTime(this.smoothedEngineGain, now);
    continuous.boostGain.gain.setValueAtTime(this.smoothedBoostGain, now);
  }

  private fadeContinuousLayers(): void {
    this.engineActive = false;
    this.boostActive = false;
    this.smoothedEngineGain = 0;
    this.smoothedBoostGain = 0;
    const graph = this.graph;
    const continuous = this.continuous;
    if (!graph || !continuous) return;

    const now = graph.context.currentTime;
    continuous.engineGain.gain.cancelScheduledValues(now);
    continuous.engineGain.gain.setTargetAtTime(0, now, AUDIO.MASTER.FADE_OUT_SECONDS);
    continuous.boostGain.gain.cancelScheduledValues(now);
    continuous.boostGain.gain.setTargetAtTime(0, now, AUDIO.MASTER.FADE_OUT_SECONDS);
  }

  private resetSessionBoundary(roomId: string | null, sessionId: string | null): void {
    this.tracker.reset();
    this.transitionQueue.clear();
    this.stopOneShots();
    this.fadeContinuousLayers();
    this.roomId = roomId;
    this.sessionId = sessionId;
    this.phase = null;
    this.hadState = false;
    this.lastObservedSequence = null;
  }

  private dispatchEvent(event: TrackedAudioEvent, camera: THREE.Camera | null): void {
    if (document.hidden || this.muted || this.volume <= 0) return;
    const graph = this.graph;
    if (!graph) return;
    if (graph.context.state === 'running') {
      this.playEvent(event, camera);
      return;
    }
    if (graph.context.state !== 'closed' && isQueueableTransition(event.type)) {
      this.transitionQueue.enqueue(event);
    }
  }

  private flushQueuedTransitions(): void {
    const graph = this.graph;
    if (document.hidden || this.muted || this.volume <= 0) {
      this.transitionQueue.clear();
      return;
    }
    if (!graph || graph.context.state !== 'running') return;
    for (const event of this.transitionQueue.drain()) this.playEvent(event, null);
  }

  private playEvent(event: TrackedAudioEvent, camera: THREE.Camera | null): void {
    const graph = this.graph;
    if (
      !graph
      || graph.context.state !== 'running'
      || document.hidden
      || this.muted
      || this.volume <= 0
    ) return;

    const pan = event.source && camera ? this.getPan(event.source, camera) : 0;
    const strength = clamp(event.strength, 0, 1);
    this.eventPlayCounts[event.type] += 1;

    switch (event.type) {
      case 'jump':
        this.playTone('sawtooth', AUDIO.JUMP.START_FREQUENCY_HZ, AUDIO.JUMP.END_FREQUENCY_HZ,
          AUDIO.JUMP.GAIN, AUDIO.JUMP.ATTACK_SECONDS, AUDIO.JUMP.DURATION_SECONDS, pan);
        this.playNoise(AUDIO.JUMP.NOISE_GAIN, AUDIO.JUMP.NOISE_FILTER_HZ,
          AUDIO.JUMP.NOISE_FILTER_Q, AUDIO.JUMP.ATTACK_SECONDS, AUDIO.JUMP.DURATION_SECONDS, pan);
        break;
      case 'landing': {
        const gain = AUDIO.LANDING.MIN_GAIN
          + (AUDIO.LANDING.MAX_GAIN - AUDIO.LANDING.MIN_GAIN) * strength;
        this.playTone('triangle', AUDIO.LANDING.START_FREQUENCY_HZ,
          AUDIO.LANDING.END_FREQUENCY_HZ, gain, AUDIO.LANDING.ATTACK_SECONDS,
          AUDIO.LANDING.DURATION_SECONDS, pan);
        this.playNoise(AUDIO.LANDING.NOISE_GAIN * strength, AUDIO.LANDING.NOISE_FILTER_HZ,
          AUDIO.LANDING.NOISE_FILTER_Q, AUDIO.LANDING.ATTACK_SECONDS,
          AUDIO.LANDING.DURATION_SECONDS, pan);
        break;
      }
      case 'impact': {
        const toneGain = AUDIO.IMPACT.MIN_GAIN
          + (AUDIO.IMPACT.MAX_GAIN - AUDIO.IMPACT.MIN_GAIN) * strength;
        const noiseGain = AUDIO.IMPACT.NOISE_MIN_GAIN
          + (AUDIO.IMPACT.NOISE_MAX_GAIN - AUDIO.IMPACT.NOISE_MIN_GAIN) * strength;
        this.playTone('triangle', AUDIO.IMPACT.START_FREQUENCY_HZ,
          AUDIO.IMPACT.END_FREQUENCY_HZ, toneGain, AUDIO.IMPACT.ATTACK_SECONDS,
          AUDIO.IMPACT.DURATION_SECONDS, pan);
        this.playNoise(noiseGain, AUDIO.IMPACT.NOISE_FILTER_HZ, AUDIO.IMPACT.NOISE_FILTER_Q,
          AUDIO.IMPACT.ATTACK_SECONDS, AUDIO.IMPACT.DURATION_SECONDS, pan);
        break;
      }
      case 'countdown': {
        const countdownValue = event.countdownValue ?? AUDIO.DETECTION.COUNTDOWN_MIN_VALUE;
        const frequency = AUDIO.COUNTDOWN.BASE_FREQUENCY_HZ
          + AUDIO.COUNTDOWN.STEP_FREQUENCY_HZ * countdownValue;
        this.playTone('sine', frequency, frequency, AUDIO.COUNTDOWN.GAIN,
          AUDIO.COUNTDOWN.ATTACK_SECONDS, AUDIO.COUNTDOWN.DURATION_SECONDS, 0);
        break;
      }
      case 'go':
        this.playTone('triangle', AUDIO.GO.LOW_START_FREQUENCY_HZ,
          AUDIO.GO.LOW_END_FREQUENCY_HZ, AUDIO.GO.LOW_GAIN, AUDIO.GO.ATTACK_SECONDS,
          AUDIO.GO.DURATION_SECONDS, 0);
        this.playTone('sine', AUDIO.GO.HIGH_START_FREQUENCY_HZ,
          AUDIO.GO.HIGH_END_FREQUENCY_HZ, AUDIO.GO.HIGH_GAIN, AUDIO.GO.ATTACK_SECONDS,
          AUDIO.GO.DURATION_SECONDS, 0);
        break;
      case 'goal':
        this.playGoalHorn();
        break;
      case 'overtime':
        this.playTone('square', AUDIO.OVERTIME.LOW_FREQUENCY_HZ,
          AUDIO.OVERTIME.LOW_FREQUENCY_HZ, AUDIO.OVERTIME.GAIN,
          AUDIO.OVERTIME.ATTACK_SECONDS, AUDIO.OVERTIME.DURATION_SECONDS, 0);
        this.playTone('square', AUDIO.OVERTIME.HIGH_FREQUENCY_HZ,
          AUDIO.OVERTIME.HIGH_FREQUENCY_HZ, AUDIO.OVERTIME.GAIN,
          AUDIO.OVERTIME.ATTACK_SECONDS, AUDIO.OVERTIME.DURATION_SECONDS, 0,
          AUDIO.OVERTIME.SECOND_PULSE_DELAY_SECONDS);
        break;
      case 'match-end':
        this.playTone('triangle', AUDIO.MATCH_END.HIGH_FREQUENCY_HZ,
          AUDIO.MATCH_END.HIGH_FREQUENCY_HZ, AUDIO.MATCH_END.GAIN,
          AUDIO.MATCH_END.ATTACK_SECONDS, AUDIO.MATCH_END.DURATION_SECONDS, 0);
        this.playTone('triangle', AUDIO.MATCH_END.MID_FREQUENCY_HZ,
          AUDIO.MATCH_END.MID_FREQUENCY_HZ, AUDIO.MATCH_END.GAIN,
          AUDIO.MATCH_END.ATTACK_SECONDS, AUDIO.MATCH_END.DURATION_SECONDS, 0,
          AUDIO.MATCH_END.NOTE_SPACING_SECONDS);
        this.playTone('triangle', AUDIO.MATCH_END.LOW_FREQUENCY_HZ,
          AUDIO.MATCH_END.LOW_FREQUENCY_HZ, AUDIO.MATCH_END.GAIN,
          AUDIO.MATCH_END.ATTACK_SECONDS, AUDIO.MATCH_END.DURATION_SECONDS, 0,
          AUDIO.MATCH_END.NOTE_SPACING_SECONDS * 2);
        break;
      case 'ui':
        this.playTone('sine', AUDIO.UI.START_FREQUENCY_HZ, AUDIO.UI.END_FREQUENCY_HZ,
          AUDIO.UI.GAIN, AUDIO.UI.ATTACK_SECONDS, AUDIO.UI.DURATION_SECONDS, 0);
        break;
    }
  }

  private playGoalHorn(): void {
    const frequencies = [
      AUDIO.GOAL.ROOT_FREQUENCY_HZ,
      AUDIO.GOAL.ROOT_FREQUENCY_HZ * AUDIO.GOAL.THIRD_RATIO,
      AUDIO.GOAL.ROOT_FREQUENCY_HZ * AUDIO.GOAL.FIFTH_RATIO,
    ];
    const gains = [AUDIO.GOAL.ROOT_GAIN, AUDIO.GOAL.THIRD_GAIN, AUDIO.GOAL.FIFTH_GAIN];
    for (let index = 0; index < frequencies.length; index++) {
      this.playTone('sawtooth', frequencies[index] * AUDIO.GOAL.START_RATIO,
        frequencies[index], gains[index], AUDIO.GOAL.ATTACK_SECONDS,
        AUDIO.GOAL.DURATION_SECONDS, 0);
      this.playTone('sawtooth', frequencies[index] * AUDIO.GOAL.START_RATIO,
        frequencies[index], gains[index] * AUDIO.GOAL.SECOND_HIT_GAIN_RATIO,
        AUDIO.GOAL.ATTACK_SECONDS, AUDIO.GOAL.DURATION_SECONDS, 0,
        AUDIO.GOAL.SECOND_HIT_DELAY_SECONDS);
    }
  }

  private playTone(
    type: OscillatorType,
    startFrequencyHz: number,
    endFrequencyHz: number,
    gainAmount: number,
    attackSeconds: number,
    durationSeconds: number,
    pan: number,
    delaySeconds = 0,
  ): void {
    const graph = this.graph;
    if (!graph) return;
    const { context } = graph;
    const startAt = context.currentTime + Math.max(0, delaySeconds);
    const stopAt = startAt + Math.max(attackSeconds, durationSeconds);
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(Number.EPSILON, startFrequencyHz), startAt);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(Number.EPSILON, endFrequencyHz),
      stopAt,
    );

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(AUDIO.MASTER.SILENCE_GAIN, startAt);
    envelope.gain.linearRampToValueAtTime(
      clamp(gainAmount, AUDIO.MASTER.SILENCE_GAIN, AUDIO.MASTER.MAX_GAIN),
      startAt + Math.max(0, attackSeconds),
    );
    envelope.gain.exponentialRampToValueAtTime(AUDIO.MASTER.SILENCE_GAIN, stopAt);
    oscillator.connect(envelope);

    const nodes: AudioNode[] = [oscillator, envelope];
    this.connectSpatial(envelope, pan, nodes);
    const voice = this.trackVoice(oscillator, nodes);
    oscillator.onended = () => this.releaseVoice(voice);
    oscillator.start(startAt);
    oscillator.stop(stopAt + AUDIO.MASTER.PARAMETER_SMOOTH_SECONDS);
  }

  private playNoise(
    gainAmount: number,
    filterFrequencyHz: number,
    filterQ: number,
    attackSeconds: number,
    durationSeconds: number,
    pan: number,
  ): void {
    const graph = this.graph;
    if (!graph) return;
    const { context, noiseBuffer } = graph;
    const startAt = context.currentTime;
    const stopAt = startAt + Math.max(attackSeconds, durationSeconds);
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFrequencyHz;
    filter.Q.value = filterQ;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(AUDIO.MASTER.SILENCE_GAIN, startAt);
    envelope.gain.linearRampToValueAtTime(
      clamp(gainAmount, AUDIO.MASTER.SILENCE_GAIN, AUDIO.MASTER.MAX_GAIN),
      startAt + Math.max(0, attackSeconds),
    );
    envelope.gain.exponentialRampToValueAtTime(AUDIO.MASTER.SILENCE_GAIN, stopAt);
    source.connect(filter);
    filter.connect(envelope);

    const nodes: AudioNode[] = [source, filter, envelope];
    this.connectSpatial(envelope, pan, nodes);
    const voice = this.trackVoice(source, nodes);
    source.onended = () => this.releaseVoice(voice);
    source.start(startAt);
    source.stop(stopAt + AUDIO.MASTER.PARAMETER_SMOOTH_SECONDS);
  }

  private connectSpatial(source: AudioNode, pan: number, nodes: AudioNode[]): void {
    const graph = this.graph;
    if (!graph) return;
    const createStereoPanner = graph.context.createStereoPanner?.bind(graph.context);
    if (createStereoPanner) {
      const panner = createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      source.connect(panner);
      panner.connect(graph.limiter);
      nodes.push(panner);
    } else {
      source.connect(graph.limiter);
    }
  }

  private getPan(source: Vector3Like, camera: THREE.Camera): number {
    camera.updateMatrixWorld();
    this.cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    return calculateStereoPan(source, camera.position, this.cameraRight);
  }

  private trackVoice(source: AudioScheduledSourceNode, nodes: AudioNode[]): OneShotVoice {
    const voice = { source, nodes };
    this.oneShotVoices.add(voice);
    return voice;
  }

  private releaseVoice(voice: OneShotVoice): void {
    if (!this.oneShotVoices.delete(voice)) return;
    for (const node of voice.nodes) this.disconnectNode(node);
  }

  private stopOneShots(): void {
    for (const voice of this.oneShotVoices) {
      try {
        voice.source.stop();
      } catch {
        // Already-ended sources are harmless during room and page cleanup.
      }
      for (const node of voice.nodes) this.disconnectNode(node);
    }
    this.oneShotVoices.clear();
  }

  private disposeAudioGraph(closeContext: boolean): void {
    const graph = this.graph;
    this.stopOneShots();
    this.disposeContinuousGraph();
    if (!graph) return;

    this.disconnectNode(graph.limiter);
    this.disconnectNode(graph.masterGain);
    this.graph = null;
    if (closeContext && graph.context.state !== 'closed') {
      try {
        void graph.context.close().catch(() => undefined);
      } catch {
        // Context closure is best-effort during failure and page teardown.
      }
    }
  }

  private disposeContinuousGraph(): void {
    const continuous = this.continuous;
    if (!continuous) return;
    this.stopSource(continuous.enginePrimary);
    this.stopSource(continuous.engineHarmonic);
    this.stopSource(continuous.boostSource);
    for (const node of Object.values(continuous)) this.disconnectNode(node);
    this.continuous = null;
  }

  private stopSource(source: AudioScheduledSourceNode): void {
    try {
      source.stop();
    } catch {
      // A browser may already have stopped a source while closing its context.
    }
  }

  private disconnectNode(node: AudioNode | null | undefined): void {
    if (!node) return;
    try {
      node.disconnect();
    } catch {
      // Disconnect is idempotent for cleanup purposes across browser engines.
    }
  }

  private effectiveMasterGain(): number {
    return this.muted ? 0 : this.volume * AUDIO.MASTER.MAX_GAIN;
  }

  /** External entry points for the same state the built-in aside controls. */
  applyMuted(muted: boolean): void {
    this.setMuted(muted === true);
  }

  applyVolume(volume: number): void {
    this.setVolume(volume);
  }

  private setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain();
    this.persistSettings();
    this.updateControl();
    if (muted) {
      this.transitionQueue.clear();
      this.stopOneShots();
      this.fadeContinuousLayers();
    }
  }

  private setVolume(volume: number): void {
    this.volume = normalizeVolume(volume);
    this.applyMasterGain();
    this.persistSettings();
    this.updateControl();
    if (this.volume <= 0) this.transitionQueue.clear();
  }

  private applyMasterGain(): void {
    const graph = this.graph;
    if (!graph) return;
    const now = graph.context.currentTime;
    graph.masterGain.gain.cancelScheduledValues(now);
    graph.masterGain.gain.setTargetAtTime(
      this.effectiveMasterGain(),
      now,
      AUDIO.MASTER.PARAMETER_SMOOTH_SECONDS,
    );
  }

  private persistSettings(): void {
    try {
      localStorage.setItem(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify({
        muted: this.muted,
        volume: this.volume,
      }));
    } catch {
      // Audio remains usable when storage is blocked or full.
    }
  }

  private createControl(): void {
    if (document.getElementById(AUDIO_CONTROL_ID)) return;
    const style = document.createElement('style');
    style.id = AUDIO_CONTROL_STYLE_ID;
    style.textContent = `
      #${AUDIO_CONTROL_ID} {
        position: fixed;
        top: 0.75rem;
        right: 0.75rem;
        z-index: 80;
        display: grid;
        grid-template-columns: auto 5.25rem auto;
        align-items: center;
        gap: 0.45rem;
        box-sizing: border-box;
        min-height: 2.25rem;
        padding: 0.35rem 0.5rem;
        border: 1px solid rgba(120, 169, 186, 0.48);
        border-radius: 0.45rem;
        background: rgba(4, 7, 13, 0.88);
        color: #e9f4f6;
        font: 700 0.68rem/1 monospace;
        letter-spacing: 0.04em;
        pointer-events: auto;
        box-shadow: 0 0.35rem 1rem rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(0.35rem);
      }
      #${AUDIO_CONTROL_ID} button {
        min-width: 3.5rem;
        padding: 0.35rem 0.42rem;
        border: 1px solid rgba(102, 183, 255, 0.68);
        border-radius: 0.3rem;
        background: rgba(47, 120, 255, 0.2);
        color: inherit;
        font: inherit;
        letter-spacing: inherit;
        cursor: pointer;
      }
      #${AUDIO_CONTROL_ID} button[aria-pressed="true"] {
        border-color: rgba(255, 106, 42, 0.75);
        background: rgba(255, 106, 42, 0.18);
        color: #ffb05d;
      }
      #${AUDIO_CONTROL_ID} input[type="range"] {
        width: 5.25rem;
        margin: 0;
        accent-color: #66b7ff;
        cursor: pointer;
      }
      #${AUDIO_CONTROL_ID} output {
        min-width: 2.25rem;
        color: #c6d7df;
        text-align: right;
      }
      #${AUDIO_CONTROL_ID} button:focus-visible,
      #${AUDIO_CONTROL_ID} input:focus-visible {
        outline: 2px solid #ffcc00;
        outline-offset: 2px;
      }
      @media (max-width: 420px) {
        #${AUDIO_CONTROL_ID} {
          top: 0.5rem;
          right: 0.5rem;
          grid-template-columns: auto 4rem;
        }
        #${AUDIO_CONTROL_ID} input[type="range"] { width: 4rem; }
        #${AUDIO_CONTROL_ID} output { display: none; }
      }
    `;
    document.head.appendChild(style);

    const control = document.createElement('aside');
    control.id = AUDIO_CONTROL_ID;
    control.setAttribute('aria-label', 'Sound controls');
    control.innerHTML = `
      <button type="button" aria-pressed="false">SOUND</button>
      <label class="sr-only" for="rocket-audio-volume">Sound volume</label>
      <input id="rocket-audio-volume" type="range" min="0" max="1"
        step="${AUDIO.MASTER.VOLUME_STEP}" aria-label="Sound volume">
      <output for="rocket-audio-volume" aria-hidden="true"></output>
    `;
    document.body.appendChild(control);

    this.control = control;
    this.controlStyle = style;
    this.muteButton = control.querySelector('button');
    this.volumeInput = control.querySelector('input');
    this.volumeOutput = control.querySelector('output');
    this.muteButton?.addEventListener('click', this.handleMuteButtonClick);
    this.volumeInput?.addEventListener('input', this.handleVolumeInput);
    this.updateControl();
  }

  private updateControl(): void {
    if (this.muteButton) {
      this.muteButton.textContent = this.muted ? 'MUTED' : 'SOUND';
      this.muteButton.setAttribute('aria-pressed', String(this.muted));
      this.muteButton.setAttribute('aria-label', this.muted ? 'Unmute sound' : 'Mute sound');
      this.muteButton.title = this.muted ? 'Unmute sound' : 'Mute sound';
    }
    if (this.volumeInput) {
      this.volumeInput.value = String(this.volume);
      this.volumeInput.setAttribute('aria-valuetext', `${Math.round(this.volume * 100)} percent`);
    }
    if (this.volumeOutput) this.volumeOutput.value = `${Math.round(this.volume * 100)}%`;
  }
}

const audioManager = new ProceduralAudioManager();

export function initializeAudio(): void {
  audioManager.initialize();
}

export function updateAudio(frame: AudioFrame): void {
  audioManager.update(frame);
}

export function cleanupAudio(): void {
  audioManager.cleanup();
}

export function getAudioDebugState(): AudioDebugState {
  return audioManager.getDebugState();
}

/**
 * Mute state and volume, for a settings surface other than the built-in aside.
 *
 * These delegate to the same private setters the aside's own controls use, and
 * those already persist and call updateControl(), so the aside stays in step
 * without the caller having to touch it. This exists so a settings panel drives
 * one source of truth instead of keeping a second copy of the audio state.
 */
export function setAudioMuted(muted: boolean): void {
  audioManager.applyMuted(muted);
}

export function setAudioVolume(volume: number): void {
  audioManager.applyVolume(volume);
}

export function getAudioSettings(): { readonly volume: number; readonly muted: boolean } {
  const state = audioManager.getDebugState();
  return Object.freeze({ volume: state.volume, muted: state.muted });
}
