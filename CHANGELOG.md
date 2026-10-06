# Changelog

## [0.9.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.8.0...timeclock-v0.9.0) (2026-10-06)


### Features

* add user menu and read-only people profiles ([#34](https://github.com/giraffesyo/timeclock/issues/34)) ([77112b4](https://github.com/giraffesyo/timeclock/commit/77112b4326c8b2c98a7b841088a66f9f4f1b6e7a))


### Bug Fixes

* resume bounded Toggl history imports promptly ([#37](https://github.com/giraffesyo/timeclock/issues/37)) ([91ba6e8](https://github.com/giraffesyo/timeclock/commit/91ba6e8dbc72a1ecac872836bb49eb8ab86b15ff))
* use one Toggl report pagination cursor ([#36](https://github.com/giraffesyo/timeclock/issues/36)) ([9d8375d](https://github.com/giraffesyo/timeclock/commit/9d8375d3f181e7104c6c3da4ac9b2b3e8a6a4049))

## [0.8.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.7.0...timeclock-v0.8.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* **cli:** drop the --server flag ([#30](https://github.com/giraffesyo/timeclock/issues/30))

### Features

* **cli:** drop the --server flag ([#30](https://github.com/giraffesyo/timeclock/issues/30)) ([dfe51ad](https://github.com/giraffesyo/timeclock/commit/dfe51ad5d82eb16f5de4eefd161a05865fda30f4))
* **cli:** sign in to embedded hosts with an API key ([#32](https://github.com/giraffesyo/timeclock/issues/32)) ([99e63a3](https://github.com/giraffesyo/timeclock/commit/99e63a372967d43c7e368d994fc72352b76d600d))


### Bug Fixes

* batch unchanged Toggl entry reconciliation ([#33](https://github.com/giraffesyo/timeclock/issues/33)) ([5629dd0](https://github.com/giraffesyo/timeclock/commit/5629dd0223ba5d7a7ce63fe87a9fbe1303476027))

## [0.7.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.6.0...timeclock-v0.7.0) (2026-10-06)


### Features

* **cli:** take the server as an argument to auth login ([#27](https://github.com/giraffesyo/timeclock/issues/27)) ([fb7b788](https://github.com/giraffesyo/timeclock/commit/fb7b7882f4205490a56e3ddd6e93740230c59997))


### Bug Fixes

* let Toggl imports use the full workspace sync timeout ([#28](https://github.com/giraffesyo/timeclock/issues/28)) ([0e3fa37](https://github.com/giraffesyo/timeclock/commit/0e3fa371a36ea4bb11c96b56802e3315588c601c))

## [0.6.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.5.1...timeclock-v0.6.0) (2026-10-06)


### Features

* add Go CLI with OAuth login and release binaries ([#24](https://github.com/giraffesyo/timeclock/issues/24)) ([ef87776](https://github.com/giraffesyo/timeclock/commit/ef87776dab11f1456526d349a1ac0d0496626037))
* organize settings and show host avatars ([#21](https://github.com/giraffesyo/timeclock/issues/21)) ([1e8bbaa](https://github.com/giraffesyo/timeclock/commit/1e8bbaa68cd8798c61fafa9e954f581e2326d2bd))

## [0.5.1](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.5.0...timeclock-v0.5.1) (2026-10-06)


### Bug Fixes

* respect Toggl report date limits during historical sync ([#22](https://github.com/giraffesyo/timeclock/issues/22)) ([ebbae2a](https://github.com/giraffesyo/timeclock/commit/ebbae2a69bfe970f66761a70428f691476d69040))

## [0.5.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.4.0...timeclock-v0.5.0) (2026-10-05)


### Features

* add two-way Toggl integration with historical sync ([39ac94f](https://github.com/giraffesyo/timeclock/commit/39ac94fdb80b61477d887ac590fee7a0b3347be1))

## [0.4.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.3.0...timeclock-v0.4.0) (2026-10-05)


### Features

* a second step at sign-in, passkeys, and single sign-on per workspace ([#16](https://github.com/giraffesyo/timeclock/issues/16)) ([9db7986](https://github.com/giraffesyo/timeclock/commit/9db798600568628bf811dc4213b8f7c461304d18))
* a standalone server's own accounts, with passwords, invitations and workspaces to switch between ([#15](https://github.com/giraffesyo/timeclock/issues/15)) ([71ba7e3](https://github.com/giraffesyo/timeclock/commit/71ba7e343d6faaaa5c1c3d27da36008e198a9bc1))
* improve calendar editing and workspace entry requirements ([4565fce](https://github.com/giraffesyo/timeclock/commit/4565fcecffc2e536d3e449d5d32040fab8272d38))
* themes from a few values, set by a workspace admin or a host, and a light/dark switch ([#12](https://github.com/giraffesyo/timeclock/issues/12)) ([9f42532](https://github.com/giraffesyo/timeclock/commit/9f42532191839ba823c7d92a248d001805ce3a5e))
* workspaces, with every table and query scoped to one ([#14](https://github.com/giraffesyo/timeclock/issues/14)) ([179d6b7](https://github.com/giraffesyo/timeclock/commit/179d6b7237661e73e3598cf76a13fec778337326))


### Bug Fixes

* enforce required timer fields when stopping ([48bf0c8](https://github.com/giraffesyo/timeclock/commit/48bf0c81cf1aabf6192a64fb1fa627a6b4d0d370))

## [0.3.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.2.0...timeclock-v0.3.0) (2026-10-03)


### Features

* a sidebar, the page on a sheet, and an edge-to-edge calendar ([#10](https://github.com/giraffesyo/timeclock/issues/10)) ([40d8d01](https://github.com/giraffesyo/timeclock/commit/40d8d015c22d33a419a3529db2d8cdc39ec6c6ed))
