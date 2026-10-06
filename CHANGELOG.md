# Changelog

## [0.13.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.12.0...timeclock-v0.13.0) (2026-10-06)


### Features

* edit a person from the row menu, in a dialog ([#54](https://github.com/giraffesyo/timeclock/issues/54)) ([56a92df](https://github.com/giraffesyo/timeclock/commit/56a92df67130f9578d4bd30c290afc4e6aa4f576))

## [0.12.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.11.0...timeclock-v0.12.0) (2026-10-06)


### Features

* export ClockButton, the clock as a header button ([#50](https://github.com/giraffesyo/timeclock/issues/50)) ([f396ad5](https://github.com/giraffesyo/timeclock/commit/f396ad571517eb86eacea5b1a4487680c2fe9046))

## [0.11.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.10.0...timeclock-v0.11.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* stop listing overtime as an exception ([#49](https://github.com/giraffesyo/timeclock/issues/49))
* GET /api/v1/activity is now GET /api/v1/clocked-in, and the CLI's activity command is clocked-in.

### Features

* change several people at once from a selection or right click ([#44](https://github.com/giraffesyo/timeclock/issues/44)) ([6a63eb7](https://github.com/giraffesyo/timeclock/commit/6a63eb74529bcc22937162771aba7eb327cb342a))
* keep the clock bar on the Timer page, drop the user menu arrow ([#42](https://github.com/giraffesyo/timeclock/issues/42)) ([222e7e0](https://github.com/giraffesyo/timeclock/commit/222e7e0b7deb6bb83185de7a06450895e2f5ff00))
* let hosts allow image origins for directory photos ([#47](https://github.com/giraffesyo/timeclock/issues/47)) ([d25c5f7](https://github.com/giraffesyo/timeclock/commit/d25c5f7cc7154c678e9e8fa28c077321a6ef31f9))
* make admins in Timeclock, with a row menu, badges and confirmations ([#48](https://github.com/giraffesyo/timeclock/issues/48)) ([04f12c9](https://github.com/giraffesyo/timeclock/commit/04f12c98f79de950fffb78ae59ff3a683215c8a2))
* per-person timesheet submission, with a workspace default ([#46](https://github.com/giraffesyo/timeclock/issues/46)) ([e8e8276](https://github.com/giraffesyo/timeclock/commit/e8e82764fa69f3239946e9821b24fa6a36e8d5a6))


### Bug Fixes

* serve who is on the clock at /clocked-in ([#45](https://github.com/giraffesyo/timeclock/issues/45)) ([2d68c2c](https://github.com/giraffesyo/timeclock/commit/2d68c2c6a0b7b40bb17b558bd7c760dfcd54f04c))
* stop listing overtime as an exception ([#49](https://github.com/giraffesyo/timeclock/issues/49)) ([ef0c3cb](https://github.com/giraffesyo/timeclock/commit/ef0c3cbfde89258369abb793aa45434c5bde7521))

## [0.10.0](https://github.com/giraffesyo/timeclock/compare/timeclock-v0.9.0...timeclock-v0.10.0) (2026-10-06)


### Features

* compact time editor ([#41](https://github.com/giraffesyo/timeclock/issues/41)) ([a963367](https://github.com/giraffesyo/timeclock/commit/a9633674667aafbb17f27a10beb25e5b1d35841e))


### Bug Fixes

* keep shared queries loading after a save ([#39](https://github.com/giraffesyo/timeclock/issues/39)) ([fa083f7](https://github.com/giraffesyo/timeclock/commit/fa083f7b10a05ea2316832f1b5b66d92047322b8))

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
