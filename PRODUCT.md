# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Desktop players who want a short, immediately readable competitive car-ball match with friends or other local browser clients.

## Product Purpose

Rocket Arena is a browser-based 2v2 multiplayer car-ball game. Success means players can enter a room quickly, understand team and match state at a glance, and experience responsive, authoritative driving and ball impacts through a complete timed match.

## Positioning

The entire playable experience is delivered as a text-reviewable web project: authoritative Rapier simulation, Colyseus synchronization, and a distinctive Three.js world built only from procedural geometry and materials.

## Operating Context

Players use a desktop keyboard, join through Quick Match or a six-character Custom Room code, and play in one or more browser windows against a single local server process.

## Capabilities and Constraints

- Two fixed teams of two, five-minute matches, and golden-goal overtime.
- Cars accelerate, brake, steer, jump, boost, and receive airborne control.
- The server owns all physics; clients send input and render synchronized state.
- No accounts, persistence, database, authentication, mobile controls, skill rating, bot fill, or horizontal scaling.
- Visuals use Three.js procedural geometry and materials only. No imported models, image textures, fetched resources, or external runtime assets.
- Physical car, ball, arena, and goal dimensions remain the authoritative visual scale.

## Brand Commitments

The product name is Rocket Arena. The world must remain visibly original and use only Rocket Arena wording; it must not reproduce recognizable proprietary vehicles, ball panel layouts, stadium geometry, logos, or branding.

## Evidence on Hand

The repository contains a playable authoritative multiplayer loop, deterministic physics harnesses, lobby and custom-room flows, synchronized HUD state, and procedural renderer code. There are no external visual assets or commercial claims to present.

## Product Principles

- Preserve authoritative playability before visual spectacle.
- Make team, ball, goal, and motion state readable at gameplay distance.
- Build visual identity from reusable procedural systems rather than borrowed assets.
- Spend performance on silhouette, lighting hierarchy, and motion cues that improve play.
- Keep setup local, zero-config, and reviewable from source.
