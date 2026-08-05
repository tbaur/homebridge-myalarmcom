# Changelog

## [1.0.1](https://github.com/tbaur/homebridge-myalarmcom/compare/v1.0.0...v1.0.1) (2026-08-05)


### Bug Fixes

* make-before-break event stream refresh cutover ([#38](https://github.com/tbaur/homebridge-myalarmcom/issues/38)) ([e677c84](https://github.com/tbaur/homebridge-myalarmcom/commit/e677c846f07180cc7b75f15354681e3fa8971f9a))

## [1.0.0](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.14...v1.0.0) (2026-08-05)


### Features

* graduate to 1.0.0 ([d27539d](https://github.com/tbaur/homebridge-myalarmcom/commit/d27539dcc27d74388299fc88dca9422a64faf54e))

## [0.1.14](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.13...v0.1.14) (2026-08-05)


### Bug Fixes

* correct HomeKit alarm state, cancel stalled polls, and close redaction gaps ([#34](https://github.com/tbaur/homebridge-myalarmcom/issues/34)) ([642d2dd](https://github.com/tbaur/homebridge-myalarmcom/commit/642d2ddced2a7dfada703064bc09204f8b28b71c))

## [0.1.13](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.12...v0.1.13) (2026-08-02)


### Bug Fixes

* idempotent shutdown and discovery test race ([#31](https://github.com/tbaur/homebridge-myalarmcom/issues/31)) ([8be6dc7](https://github.com/tbaur/homebridge-myalarmcom/commit/8be6dc7b649111e4b0c7672d5f6f74c0db2e21ad))

## [0.1.12](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.11...v0.1.12) (2026-08-02)


### Bug Fixes

* demote Alarm.com 403 poll failures to debug ([#29](https://github.com/tbaur/homebridge-myalarmcom/issues/29)) ([f3464df](https://github.com/tbaur/homebridge-myalarmcom/commit/f3464df3dc839c4c30d5258f21249ab4d8379ba9))

## [0.1.11](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.10...v0.1.11) (2026-08-01)


### Bug Fixes

* clarify read-only account arming log message ([#27](https://github.com/tbaur/homebridge-myalarmcom/issues/27)) ([bd35ed5](https://github.com/tbaur/homebridge-myalarmcom/commit/bd35ed52c718918d43b6f8efa2293cf8b41ce38a))

## [0.1.10](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.9...v0.1.10) (2026-08-01)


### Bug Fixes

* allow diagnostics intervals up to 24 hours ([#25](https://github.com/tbaur/homebridge-myalarmcom/issues/25)) ([666f250](https://github.com/tbaur/homebridge-myalarmcom/commit/666f2507d46e97b6dc87a103e46b2e268516df9b))

## [0.1.9](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.8...v0.1.9) (2026-08-01)


### Bug Fixes

* prevent event stream crash and improve config UX ([#23](https://github.com/tbaur/homebridge-myalarmcom/issues/23)) ([20a307e](https://github.com/tbaur/homebridge-myalarmcom/commit/20a307e2935966d8f6f78105d0461ecc8d79e459))

## [0.1.8](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.7...v0.1.8) (2026-07-30)


### Bug Fixes

* demote routine rediscovery inventory log to debug ([#21](https://github.com/tbaur/homebridge-myalarmcom/issues/21)) ([b4954c8](https://github.com/tbaur/homebridge-myalarmcom/commit/b4954c8d79c12e7e90732d9e8f9353e568a85cdf))

## [0.1.7](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.6...v0.1.7) (2026-07-29)


### Bug Fixes

* harden connection, session, and discovery edge cases ([#18](https://github.com/tbaur/homebridge-myalarmcom/issues/18)) ([1ea0a8e](https://github.com/tbaur/homebridge-myalarmcom/commit/1ea0a8edc82282a381d9b544fbce700388cd0f34))

## [0.1.6](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.5...v0.1.6) (2026-07-29)


### Bug Fixes

* refresh event stream before Alarm.com token expiry ([#16](https://github.com/tbaur/homebridge-myalarmcom/issues/16)) ([25544ff](https://github.com/tbaur/homebridge-myalarmcom/commit/25544ff911e876d57278951f2c6d83b921906668))

## [0.1.5](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.4...v0.1.5) (2026-07-29)


### Bug Fixes

* quiet stream refreshes and harden Alarm.com connection races ([#14](https://github.com/tbaur/homebridge-myalarmcom/issues/14)) ([5087798](https://github.com/tbaur/homebridge-myalarmcom/commit/50877980f7e1750294faa172e6a454e3b9b87a47))

## [0.1.4](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.3...v0.1.4) (2026-07-29)


### Bug Fixes

* ignored-device UI and Ready-last startup logs ([#12](https://github.com/tbaur/homebridge-myalarmcom/issues/12)) ([d5016ed](https://github.com/tbaur/homebridge-myalarmcom/commit/d5016ed0ee45d2d99aeb89f90bbcdaf38b29a896))

## [0.1.3](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.2...v0.1.3) (2026-07-29)


### Bug Fixes

* fingerprint secrets with scrypt for log previews ([#10](https://github.com/tbaur/homebridge-myalarmcom/issues/10)) ([ccec1ae](https://github.com/tbaur/homebridge-myalarmcom/commit/ccec1aeea22289a23f5257776c73c791b725ba0b))

## [0.1.2](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.1...v0.1.2) (2026-07-29)


### Bug Fixes

* human-readable logging and state change updates ([#8](https://github.com/tbaur/homebridge-myalarmcom/issues/8)) ([4a9cb9a](https://github.com/tbaur/homebridge-myalarmcom/commit/4a9cb9a09eb98a055ad4eb0603e316754264f680))

## [0.1.1](https://github.com/tbaur/homebridge-myalarmcom/compare/v0.1.0...v0.1.1) (2026-07-29)


### Features

* add opt-in diagnostics health logging ([#3](https://github.com/tbaur/homebridge-myalarmcom/issues/3)) ([d26da30](https://github.com/tbaur/homebridge-myalarmcom/commit/d26da305f39def5591a10524c6124925bdf95996))

## 0.1.0 (2026-07-29)

Initial release.

* Alarm.com security panels as HomeKit security systems, with a true triggered-alarm state and read-only presentation for accounts that cannot arm.
* Contact, motion, and smoke sensors.
* Push event stream over WebSocket, with polling as the safety net.
* Client-side pacing, a circuit breaker, and hard floors on the poll and re-authentication intervals, because Alarm.com locks accounts that misbehave.
