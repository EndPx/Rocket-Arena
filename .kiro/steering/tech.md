# Tech stack and hard constraints

## Physics — Rapier only
Use Rapier via `@dimforge/rapier3d-compat` (WASM). Do not substitute Cannon-es, Ammo, or Havok — Rapier was chosen specifically because fast-moving rigid bodies (a boosting car striking a ball) stay stable where Cannon-es jitters and tunnels.

Physics runs at a fixed timestep of 1/60s, stepped manually in the server loop. Never drive the physics step from `requestAnimationFrame` or a variable delta — variable steps make the simulation non-reproducible and will break prediction later. Continuous collision detection must be enabled on the ball and on car bodies.

## Server — Colyseus, authoritative
Colyseus handles rooms, matchmaking entry points, and state sync. Each room owns one Rapier world and ticks it at a fixed 60Hz. Clients send inputs only — never positions, never velocities. The server is the sole authority on all physics state; a client that disagrees is wrong.

Room capacity is four. Use `matchMaker.joinOrCreate` for Quick Match and explicit room creation with a generated code for Custom Room.

## Client — Three.js, procedural geometry only
No `.glb`, `.gltf`, `.fbx`, texture images, or any external asset file. Every visual is built from primitive geometry (BoxGeometry, SphereGeometry, CylinderGeometry) with flat-colour or procedurally generated materials. Complex shapes come from composing primitives or manipulating BufferGeometry vertices directly. This is a hard constraint — it keeps the whole project text-based and reviewable.

The client renders server state and nothing else. Once the server loop exists, delete any local physics simulation from the client rather than leaving it dormant behind a flag.

## Netcode
Remote cars and the ball render through an interpolation buffer, rendering roughly 100ms behind the latest server snapshot to smooth out jitter. Prediction and reconciliation for the local car are a stretch goal and must be added as a separate layer on top of working interpolation, never as a replacement for it.

## Language and tooling
TypeScript throughout, strict mode on. Shared types (input payloads, state schema shapes) live in one place and are imported by both client and server — never duplicated. Vite for the client dev server and build.

## Verification discipline
Physics behaviour is verified by logging positions and velocities over a fixed number of steps and reading the numbers, before any rendering exists. Do not evaluate physics feel by looking at a rendered scene — that conflates simulation bugs with rendering bugs and doubles the debugging surface.
