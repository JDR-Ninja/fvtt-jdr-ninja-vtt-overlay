# Changelog

All notable changes to this module are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-09-09

### Added

- **Twitch chat commands** (off by default). A streamer configures on JDR Ninja which words their
  viewers may type: a word bound to a fixed dice expression, or a word bound to one of the world's
  roll tables. A table word makes this module perform a real draw, and the resulting public roll
  animates on the overlay through the ordinary relay, so what viewers see is what the table produced.
  The module polls JDR Ninja for pending draws while its own switch is on.
- That switch is deliberately separate from the roll relay: letting viewers roll dice never lets them
  draw from a world's tables by accident. Only a Game Master browser answers, because a draw writes a
  chat message into the world, and every draw stays in the world's chat log.
- Tables are named by their Foundry UUID, so tables from compendiums work, not just world-local ones.
  Right-click a table and pick Copy UUID.
- Viewers receive no reply of any kind: the module requests no Twitch write scope. A command that no
  paired browser picks up simply expires.
- Because JDR Ninja cannot see inside a world, this client is the only thing that can check a draw is
  possible. It verifies the UUID resolves, that it is really a RollTable, and that every die in the
  formula is one the overlay has a 3D mesh for (`d4` `d6` `d8` `d10` `d12` `d20`). Note what that
  excludes: `1d100`, and Foundry's default table formula `1d{results.length}`, which yields shapes
  like d7 or d13. A refused draw is logged to the console and nowhere else.

## [1.2.0] - 2026-09-06

### Added

- Optional **result card hold** (client scope, off by default): delays the roll's card in chat so
  the overlay dice land before the result is readable. Implemented as a "no earlier than" deadline
  anchored at the roll rather than an extra wait, so it composes with Dice So Nice's own hold as
  the later of the two instead of adding to it. A diagnostics row reports what is in effect.

## [1.0.0] - 2026-09-03

First public release.

### Added

- Relays every public Foundry roll to a JDR Ninja OBS overlay, replaying the exact
  pre-rolled result (formula, per-die faces, total). The server never re-rolls.
- System-agnostic capture through the core `createChatMessage` hook.
- Dice So Nice awareness: dispatch is synchronized with DSN's animation when DSN is
  installed, with a safety fallback, and a copyright-safe cosmetic appearance
  pass-through (hex colors plus material and font names only).
- In-module pairing through the RFC 8628 device authorization flow, plus a manual token
  paste fallback for locked-down environments.
- Diagnostics checklist (configuration, relay, authentication, subscription, overlay
  active, OBS connected, network) and a one-click `1d20 = 20` test roll.
- English, French, Spanish, German and Portuguese (Brazil) localization.

### Security

- Hidden rolls (GM, blind, whispered) are never relayed. The filter reads `whisper` and
  `blind` rather than `isContentVisible`, which is true for a GM even on secret rolls.
- Every setting, including the device token, is `client` scope: per browser, never
  written to the world database or exported with the world.
