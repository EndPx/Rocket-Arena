# Implementation Plan: Procedural Audio Completion

## Overview

Resume and complete only the existing procedural audio slice. All implementation work must follow the approved requirements and design in:

`D:\Belajar\Hackacton\Hackacton yang masih jalan\Kiro\Rocket-Arena\.kiro\specs\rocket-arena`

The executor must preserve `implementation-plan.md` as historical context, preserve every unrelated dirty hunk, add no dependency or external sound asset, and avoid staging or committing until automated and Playwright validation passes. Every leaf task below is required and non-optional.

## Tasks

- [x] 1. Reconcile the current audio change set
  - [x] 1.1 Audit and complete the uncommitted audio implementation against the approved requirements
    - Record `git status --short`, `git diff --name-only`, `git diff --cached --name-only`, and the current diffs or hashes for all protected dirty content before making changes.
    - Review `shared/src/constants/audio.ts`, `client/src/audio/audio-model.ts`, `client/src/audio/audio-manager.ts`, `client/tests/audio-model.test.ts`, and audio-specific wiring hunks in shared constants exports/registry, the keyboard handler, main loop, and dev panel.
    - Reconcile gesture unlock, suspended/unsupported behavior, interpolated engine and boost inputs, frame-rate-independent smoothing, authoritative cue confirmation, snapshot/contact deduplication, kickoff-teleport suppression, persistence, accessibility, reconnect/visibility cleanup, and positional panning.
    - Add or adjust focused tests and read-only debug counters only where an acceptance criterion lacks executable coverage; generated tests must run at least 100 cases and use the design's property tags.
    - Keep `PHYSICS.TIMESTEP`, accumulator/substep behavior, manual state-sync cadence, interpolation constants, quaternion slerp, bounded extrapolation, `jumpSequence`, and input heartbeat unchanged.
    - Do not modify package files, product code outside audio-specific integration hunks, git history, `implementation-plan.md`, unrelated steering files, or protected visual/stadium/physics work.
    - _Depends on: none_
    - _Requirements: 1.1-1.7, 2.1-2.6, 3.1-3.10, 4.1-4.7, 5.1-5.8, 6.1-6.6, 8.5-8.9, 9.1_

- [x] 2. Complete the automated regression checkpoint
  - [x] 2.1 Run focused tests, full regressions, type checks, builds, and diff checks; resolve only audio-caused failures
    - Run the focused command:
      - `node --import tsx --test client/tests/audio-model.test.ts client/tests/input-controller.test.ts client/tests/interpolation-buffer.test.ts server/src/rooms/fixed-step-scheduler.test.ts`
    - Run the complete TypeScript test command:
      - `node --import tsx --test client/tests/audio-model.test.ts client/tests/input-controller.test.ts client/tests/interpolation-buffer.test.ts client/tests/lobby-input.test.ts client/tests/procedural-models.test.ts client/tests/stadium-camera-effects.test.ts server/src/rooms/fixed-step-scheduler.test.ts`
    - Run every Rapier harness separately and require exit code zero:
      - `npx --no-install tsx server/src/physics/test-ball.ts`
      - `npx --no-install tsx server/src/physics/test-car.ts`
      - `npx --no-install tsx server/src/physics/test-impact.ts`
      - `npx --no-install tsx server/src/physics/test-jump-sequence.ts`
      - `npx --no-install tsx server/src/physics/test-goal-tunnel.ts`
    - Run `npm run typecheck`, `npx tsc -b shared`, `npm run build -w server`, and `npm run build -w client` and require exit code zero.
    - If a failure is caused by the audio slice, make the smallest audio-only code or test correction and rerun the failed command plus the focused command. If a failure belongs to protected dirty content, stop and report the pre-existing failure instead of editing that content.
    - Compare the working tree with the Task 1 baseline and confirm that protected dirty content and staged state are unchanged. Ensure all tests pass; ask the user if questions arise.
    - _Depends on: 1.1_
    - _Requirements: 2.4-2.5, 3.1-3.10, 5.7-5.8, 6.1-6.6, 8.1-8.9, 9.1_

- [x] 3. Produce fresh post-restart browser proof
  - [x] 3.1 Start fresh managed processes and run the complete Playwright validation matrix
    - Confirm that no stale process owns ports 2567 or 3000. Use managed background-process tooling rather than a blocking shell command to start `npm run dev:server` and `npm run dev:client` from the repository root; wait for both health logs.
    - Open `http://localhost:3000` with Playwright and collect all page exceptions and error-level console messages from navigation through teardown.
    - Record audio debug state before a gesture, perform a real pointer or keyboard gesture, and assert a running context when Web Audio is supported; verify the normal page remains usable if support is absent.
    - Verify mute and volume accessible names, `aria-pressed`, keyboard operation, visible focus, local-storage persistence, and restored state after reload.
    - Use real room input to verify engine and boost continuous-layer states, then verify one authoritative jump, landing, and impact increment apiece with no later duplicate increment from repeated snapshots.
    - Use four Playwright pages for a real quick-match countdown. Existing dev tuning may shorten countdown and match duration. Exercise countdown/start, a real goal, tied-time overtime, and match end; compare event counters across subsequent snapshots to prove deduplication.
    - Exercise hide/show, leave/rejoin, and reload boundaries; verify the first resumed snapshot produces no false landing or impact, live one-shot count returns to zero, and continuous graph count remains at most one.
    - During a visible five-second active-play interval, record accepted snapshot rate, applied render-frame delta, buffer size, underrun delta, extrapolated-frame delta, teleport-frame delta, and request-animation-frame median and p95 interval. Confirm applied render frames advance faster than accepted snapshots.
    - Preserve objective Playwright/debug output in the task execution report; do not add generated evidence files unless the user approves a path.
    - _Depends on: 2.1_
    - _Requirements: 1.1-1.7, 2.1-2.6, 3.1-3.10, 4.1-4.7, 5.1-5.8, 6.1-6.6, 7.1-7.9_

  - [x] 3.2 Resolve browser findings and rerun every affected automated and Playwright check
    - For each finding from Task 3.1, identify the violated acceptance criterion before editing and make the smallest correction inside the `Audio_Change_Set`.
    - Rerun the focused Node command and `npm run typecheck` after each correction batch; rerun the client build when client code changes.
    - Restart affected managed server or client processes from current source, rerun the failed Playwright scenario, then rerun dependent deduplication, lifecycle, cadence, and console checks.
    - If Task 3.1 found no defect, repeat the critical unlock, persistence, action-cue deduplication, cadence, and console assertions as the final browser confirmation.
    - Stop the managed processes after proof is complete and confirm zero unexpected console errors and zero unresolved browser findings.
    - Recompare protected dirty content with the Task 1 baseline before any staging operation.
    - _Depends on: 3.1_
    - _Requirements: 1.1-7.9, 8.5-8.9, 9.1_

- [x] 4. Create and push the isolated audio commit
  - [x] 4.1 Build and verify an audio-only staged diff without disturbing protected dirty work
    - Stage new audio files, focused audio tests, the validated minimal lifecycle hunk in `client/src/networking/client.ts`, `.config.kiro`, `requirements.md`, `design.md`, and `tasks.md` by explicit path. Never use `git add .` or `git add -A`.
    - For mixed files, including `client/src/main.ts`, `shared/src/constants/index.ts`, and `shared/src/constants/registry.ts`, construct and apply a non-interactive audio-only index patch; retain unrelated working-tree hunks unstaged and byte-for-byte unchanged.
    - Treat these as protected unless an audio-specific hunk was explicitly justified in Task 1: `.kiro/steering/**`, `client/index.html`, `client/src/networking/state-listener.ts`, `client/src/renderer/**`, `client/src/ui/lobby-state.ts`, `client/tests/stadium-camera-effects.test.ts`, `server/src/physics/arena.ts`, `server/src/physics/test-goal-tunnel.ts`, and `shared/src/constants/visual.ts`.
    - Inspect `git diff --cached --name-only`, the complete `git diff --cached`, and `git diff --cached --check`; map every staged hunk to a requirement and confirm package files, `implementation-plan.md`, git configuration, and protected dirty content are absent.
    - Materialize the proposed staged patch against `HEAD` in an isolated temporary worktree when mixed-file dependencies could be masked by the dirty tree. Run the focused Node command, `npm run typecheck`, `npx tsc -b shared`, `npm run build -w server`, and `npm run build -w client` against that isolated tree before approving the index.
    - Compare unstaged protected content and untracked protected files with the Task 1 baseline after staged-tree validation.
    - _Depends on: 3.2_
    - _Requirements: 8.1-8.9, 9.1-9.5_

  - [x] 4.2 Commit the verified index once, push the current branch, and confirm preservation
    - Reconfirm that automated regression results and final Playwright proof belong to the exact staged implementation and that `git diff --cached --check` passes.
    - Create one concise logical commit, for example `feat(audio): complete procedural game sound`, without amending, bypassing hooks, or staging additional files.
    - Detect the current branch and push that branch to `origin`; use `-u` only if the branch has no upstream and do not force push. The user's instruction explicitly authorizes this push after validation.
    - Verify the pushed commit identifier and remote branch, then run `git status --short`, `git diff --name-only`, and `git diff --cached --name-only`.
    - Confirm the index is empty and every remaining protected dirty or untracked item matches the Task 1 baseline; report the commit, push result, regression summary, browser telemetry, and intentionally uncommitted files.
    - _Depends on: 4.1_
    - _Requirements: 7.1-7.9, 8.1-8.9, 9.1-9.8_

- [ ] 5. Classify the remaining dirty tree without changing Git state
  - [ ] 5.1 Audit every remaining path and hunk against `eb29bf7` into safe concern groups or protected leftovers
    - Verify and record the current HEAD relative to `eb29bf7`; require an empty index before classification begins.
    - Record `git status --short`, unstaged and staged path lists, untracked paths, complete diffs, file sizes, and SHA-256 hashes for every tracked or untracked path in the remaining dirty set, including specification edits made by this workflow.
    - Inspect and semantically review every hunk in the known tracked renderer, client integration, server arena, visual constants, steering, and task-plan changes, plus every untracked renderer effect, lobby state, stadium test, goal-tunnel harness, and operational metadata file.
    - Build a classification ledger that assigns each hunk exactly one semantic concern, dependencies, behavior or requirement traceability, mapped validation checks, rationale, and a disposition of safe candidate or protected leftover.
    - Treat `.kiro/specs/**/tasks.meta.json` as operational metadata and always exclude it. Treat orchestration-only task status hunks as protected unless separately justified as intentional specification content.
    - Treat steering files as excluded by default. Reclassify a steering hunk only when intent is documented, Markdown is valid, project behavior provides direct traceability, and semantic review finds no corruption; exclude the complete file if text such as `ssssssss` is present.
    - Split mixed files such as `client/src/main.ts`, `client/src/networking/state-listener.ts`, and `client/index.html` at hunk boundaries; do not approve a complete file from a safe subset.
    - Preserve the index, commit history, remotes, and all protected bytes unchanged. Do not stage, commit, or push during this task.
    - _Depends on: 4.2_
    - _Requirements: 10.1-10.8_

- [ ] 6. Prove each candidate concern and the combined candidate set
  - [ ] 6.1 Run focused, full, physics, build, and fresh-browser validation; exclude any group that cannot pass safely
    - Create a validation matrix before execution. Map rendering and stadium changes to renderer/stadium/interpolation tests, lobby changes to lobby/input and browser navigation checks, physics changes to the goal-tunnel and related Rapier harnesses, documentation changes to Markdown/content checks, and mixed client hunks to every affected check.
    - Run focused tests for one candidate group at a time and run `git diff --check` for the candidate paths or patches. Keep the index empty throughout Task 6.
    - Run the complete TypeScript test suite and require exit code zero:
      - `node --import tsx --test client/tests/audio-model.test.ts client/tests/input-controller.test.ts client/tests/interpolation-buffer.test.ts client/tests/lobby-input.test.ts client/tests/procedural-models.test.ts client/tests/stadium-camera-effects.test.ts server/src/rooms/fixed-step-scheduler.test.ts`
    - Run all Rapier harnesses separately and require exit code zero:
      - `npx --no-install tsx server/src/physics/test-ball.ts`
      - `npx --no-install tsx server/src/physics/test-car.ts`
      - `npx --no-install tsx server/src/physics/test-impact.ts`
      - `npx --no-install tsx server/src/physics/test-jump-sequence.ts`
      - `npx --no-install tsx server/src/physics/test-goal-tunnel.ts`
    - Run `npm run typecheck`, `npx tsc -b shared`, `npm run build -w server`, and `npm run build -w client` and require exit code zero.
    - Confirm no stale process owns ports 2567 or 3000, then use managed background-process tools to start a fresh server and client. Do not launch long-running processes through a blocking shell command.
    - Use Playwright to verify page load, lobby entry, active gameplay, the rendering or physics behavior covered by each runtime candidate, and zero uncaught page exceptions or unexpected error-level console messages.
    - Reconfirm audio health by checking pre-gesture debug state, supported-context unlock, drive and boost continuous layers, authoritative cue deduplication, mute/volume persistence after reload, lifecycle counters, and no audio console regression.
    - If a mapped check fails, allow only a tiny scoped correction within the candidate's existing concern and file set, then repeat semantic classification and all affected checks. If safe completion needs redesign, a dependency, another concern, or protected-file edits, reclassify the complete candidate group as a protected leftover instead of staging it.
    - Stop managed processes after browser proof. Recompute every protected-leftover hash and require equality with the Task 5 baseline; preserve the empty index and report the final safe candidate set.
    - _Depends on: 5.1_
    - _Requirements: 7.1-7.9, 8.1-8.9, 10.8, 11.1-11.8_

- [ ] 7. Integrate only proven concerns and push reviewable history
  - [ ] 7.1 Validate exact staged trees, create small concern commits, push without force, and preserve unsafe leftovers
    - Process safe candidate groups one at a time in recorded dependency order. Stage new files by explicit path and mixed files through reviewed non-interactive index patches; never use `git add .`, `git add -A`, or whole-file staging for a mixed safe/unsafe path.
    - Never stage `.kiro/specs/**/tasks.meta.json`, non-qualified steering content, suspicious or corrupt text, orchestration-only status hunks, or any other protected leftover.
    - For each concern, inspect `git diff --cached --name-only`, the complete `git diff --cached`, and `git diff --cached --check`; map every cached hunk to the classification ledger and reject any extra path or hunk.
    - Create a temporary worktree from the current commit, apply only the exact cached patch, and run the concern's focused checks plus all applicable full tests, Rapier harnesses, type checks, builds, and fresh Playwright checks against that isolated staged tree.
    - After isolated validation passes, create one concise logical commit for that concern with its directly supporting tests. Keep independent rendering, lobby, physics, and documentation concerns in separate commits; do not create one giant commit, amend commits, bypass hooks, or create an empty commit.
    - After each commit, verify the commit diff, confirm protected paths remain unstaged with hashes matching the Task 5 baseline, and repeat staging and isolated validation for the next concern.
    - Detect the current branch and configured upstream, then push the verified concern commits to `origin` without force; use `-u` only when the branch has no upstream.
    - After push, verify the remote commit identifiers, require an empty index, compare every protected leftover with the Task 5 byte/hash baseline, and report commits by concern, validation and browser results, remote branch, and intentionally uncommitted paths with exclusion reasons.
    - _Depends on: 6.1_
    - _Requirements: 10.4-10.8, 11.8, 12.1-12.8_

## Notes

- All leaf tasks are mandatory; no test or browser-proof task may be skipped.
- Implementation must remain TypeScript and use the existing dependencies.
- Browser servers are long-running processes and must use managed background process tools, not blocking shell execution.
- A browser finding blocks staging; a staged-scope finding blocks commit; any failed validation blocks push.
- Unrelated dirty files are preservation inputs, not cleanup targets.
- Tasks 5.1, 6.1, and 7.1 are mandatory and sequential; Task 5.1 and Task 6.1 must leave the Git index empty.
- Operational metadata is never a commit candidate, and exclusion is the safe fallback for any concern that cannot satisfy the complete validation gate.
- The workflow ends after delivery reporting; it must not clean, discard, rewrite, or normalize protected leftovers.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2"] },
    { "id": 6, "tasks": ["5.1"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["7.1"] }
  ]
}
```
