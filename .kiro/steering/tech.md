# Tech stack and hard constraints

## Physics — Rapier only
Use Rapier via `@dimforge/rapier3d-compat` (WASM). Do not substitute Cannon-es, Ammo, or Havok — Rapier was chosen specifically because fast-moving rigid bodies (a boosting car striking a ball) stay stable where Cannon-es jitters and tunnels.

Physics runs at a fixed timestep of 1/60s, stepped manually in the server loop. Never drive the physics step from `requestAnimationFrame` or a variable delta — variable steps make the simulation non-reproducible and will break prediction later. Continuous collision detection must be enabled on the ball and on car bodies.

## Server — Colyseus, authoritative
Colyseus handles rooms, matchmaking entry points, and state sync. Each room owns one Rapier world and ticks it at a fixed 60Hz. Clients send inputs only — never positions, never velocities. The server is the sole authority on all physics state; a client that disagrees is wrong.

Room capacity is four. Use `matchMaker.joinOrCreate` for Quick Match and explicit room creation with a generated code for Custom Room.

## Client — Three.js with governed local assets
Three.js remains the renderer. Gameplay 3D geometry and its collision alignment must remain procedural and source-controlled: build shapes from primitives such as `BoxGeometry`, `SphereGeometry`, and `CylinderGeometry`, compose primitives, or manipulate `BufferGeometry` vertices directly. Decorative images must never define gameplay dimensions or hitboxes.

### Allowed original AI-generated 2D images
Original 2D images generated with ChatGPT/OpenAI under a participant's direction may be included as local project assets for UI backgrounds, loading art, stadium banners and decals, sky or environment art, and carefully optimized material maps. These images supplement rather than replace procedural gameplay geometry.

Use browser-friendly runtime formats: prefer `.webp`, and use `.png` only when alpha or lossless fidelity is required. Store shipped images under `client/src/assets/generated/` and import them through the client build; remote hotlinks are not allowed.

### Copyright, hackathon provenance, and human review
Every shipped image requires human review, optimization for its actual display size, a descriptive filename, and an entry in the project hackathon provenance document at `docs/asset-provenance.md`. Each provenance entry must record the generator or service, generation date, purpose, prompt summary, and the participant's human selection and editing. The README must summarize the project's AI-generated asset use and point readers to the provenance document.

Never prompt for, copy, trace, or reproduce recognizable third-party franchise assets, logos, trademarks, exact vehicle or ball panel layouts, stadium designs, or copyrighted characters. Reference links are permitted only for mood and high-level design research; referenced files and materials must not be imported into the project. Do not present AI-generated images as fully human-created. Participant direction, selection, and review remain mandatory.

### 3D model and physics boundaries
Downloaded third-party 3D models in `.glb`, `.gltf`, `.fbx`, or equivalent formats remain disallowed. An original 3D model created specifically for Rocket Arena requires a separate explicit spec revision before inclusion and its own provenance entry.

Physics colliders remain simple, authoritative Rapier geometry. Never derive colliders blindly from decorative images or material maps; collision dimensions must be intentionally defined and kept aligned with the procedural gameplay geometry.

### Image performance budget
Unless a reviewed exception is justified in the provenance document, keep UI backgrounds, loading art, and sky or environment images at or below 2048 pixels on the longest edge; keep banners, decals, and material maps at or below 1024 pixels; and keep small UI images at or below 512 pixels. Compress images appropriately, reuse shared textures instead of duplicating them, and lazy-load non-critical art where appropriate. Do not ship unnecessary 4K imagery.

The client renders gameplay entities from server-authoritative state; decorative assets are presentation only and must not carry or override simulation state. Once the server loop exists, delete any local physics simulation from the client rather than leaving it dormant behind a flag.

## Netcode
Remote cars and the ball render through an interpolation buffer, rendering roughly 100ms behind the latest server snapshot to smooth out jitter. Prediction and reconciliation for the local car are a stretch goal and must be added as a separate layer on top of working interpolation, never as a replacement for it.

## Language and tooling
TypeScript throughout, strict mode on. Shared types (input payloads, state schema shapes) live in one place and are imported by both client and server — never duplicated. Vite for the client dev server and build.

## Verification discipline
Physics behaviour is verified by logging positions and velocities over a fixed number of steps and reading the numbers, before any rendering exists. Do not evaluate physics feel by looking at a rendered scene — that conflates simulation bugs with rendering bugs and doubles the debugging surface.
