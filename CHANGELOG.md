# Changelog

All notable changes to this module are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0]

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
