# Contributing to Rocket Arena

Thanks for your interest in the project. Issues and pull requests are both welcome,
whether you are fixing a bug, tuning a mechanic, or improving the documentation.

## Getting set up

```bash
git clone https://github.com/EndPx/Rocket-Arena.git
cd Rocket-Arena
npm install
npm run dev
```

That starts the Colyseus server and the Vite client together. One browser tab is
enough to play: choose **Custom**, create a room, and press **Start Match**.

## Before you open a pull request

Please run all four of these. They are the same checks the project holds itself to.

```bash
npm run typecheck     # tsc -b across shared, server, and client
npm test              # unit, property, and integration tests
npm run test:physics  # Rapier harnesses
npm run build         # server and client production builds
```

If your change touches physics, camera framing, or anything else where "it feels
right" is the real acceptance criterion, add or extend a bench under `bench/` and
put the numbers in the pull request. Measurements settle those discussions much
faster than screenshots do.

## Boundaries the codebase relies on

These are enforced by the TypeScript project references, and breaking one is
usually a sign that a value belongs somewhere else:

- `shared/` imports nothing from `client/` or `server/`.
- `client/` and `server/` never import one another.
- All Rapier authority stays in `server/`. The client sends control intent only.
- Gameplay constants and tuning metadata live in `shared/` and carry units.

The server owns every gameplay outcome. If a change lets a client decide a
transform, a contact, a score, a team, or a match phase, it will not be accepted.

## Tuning values

Confirmed values and unverified hypotheses are deliberately kept apart in the
tuning registry. If you change a number, say which kind it is and what evidence
you have. An honest hypothesis with a recorded measurement is worth more than a
value that merely looks right.

## Commit messages

Explain what changed and why, not just what. If a fix was non-obvious, the
reasoning that led to it is the most useful thing in the message.
