# Product: Rocket Arena

A browser-based online multiplayer car-ball game (Rocket League-style) built for a one-week hackathon. Players drive physics-driven cars in a walled arena and try to knock a large ball into the opposing goal.

## Target experience
Two teams of two (Blue vs Orange). A match runs 5 minutes; if scores are tied at time, a golden-goal overtime decides it. Cars accelerate, brake, turn, jump, and boost, with rotational air control while airborne. The ball must feel heavy and bouncy — car-ball impact is the single most important thing to get right, because the whole game is judged on that feel.

## Entry points
Quick Match joins any public room with an open slot, or creates one if none exists. When a room fills to four players it locks and runs a 5-second countdown into kickoff. Custom Room generates a 6-character alphanumeric code; the host assigns players to teams and can start with a minimum of two players.

## Non-goals — do not build these
These were deliberately cut to fit the timebox. Do not add them, do not scaffold "for later", do not suggest them in design documents:

- No matchmaking queue algorithm, no skill rating, no bot-fill. Quick Match is join-or-create only.
- No horizontal scaling, no Redis presence, no room sharding, no proxy layer. Single server process, cap concurrent rooms at 20.
- No user accounts, no auth, no persistence, no database. Players are ephemeral; nothing survives a server restart.
- No cosmetics, no progression, no unlocks, no currency.
- No 3v3. Room capacity is fixed at four.
- No mobile or touch controls. Desktop keyboard only.

## Stretch goals — only after the core loop is fully playable
Client-side prediction and reconciliation for the local car. Boost pad pickups on the arena floor. Double-jump / flip mechanics. Treat all three as optional; shipping a solid interpolated-only build beats a broken predicted one.

## Definition of done
Two browser windows on the same machine can join a match, both see the same ball position within a frame or two of each other, a goal registers and resets to kickoff, and the timer ends the match. Everything else is polish.
