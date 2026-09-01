# Changelog

All notable changes to `homebridge-cielo` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.1] - 2026-08-31

### Fixed

- Login failures now say why. They previously reported `Login failed: Unknown
  error`, which made a wrong password indistinguishable from an outage; you now
  see e.g. `Login failed: 403: forbidden`.
- The plugin no longer starts when it has not been configured. It now logs which
  settings are missing and stops, instead of attempting to connect — which would
  pay for a captcha solve only to discover it has no credentials.

## [2.2.0] - 2026-08-31

**If the plugin stopped connecting, this is the release that fixes it. Please upgrade.**

Cielo changed something on their side that broke every version before this one:
tokens issued to "web" clients stopped being accepted for listing devices or for
staying signed in. Their own web app has the same problem — it signs you in, then
immediately signs you out again. Logging in as an iOS client works, so that is
what the plugin now does.

### Fixed

- **Devices are discovered again.** The device list call was being rejected, so no
  accessories could be registered. ([#7])
- **Commands should reach your units again.** The most likely cause of commands
  appearing to send but doing nothing was this same rejection. ([#7])

### Changed

- **A captcha is now solved once, not once per reconnect.** Reconnecting reuses a
  stored token, which works under the new login type. Verified against the live
  API: four consecutive connections cost a single solve.
- Corrected the 2Captcha cost estimate in the plugin settings. It previously
  said $2–3/month; a healthy install now costs a few cents in total, not per
  month.

### Notes

- Your 2Captcha key is still required for the first sign-in after a restart.
- If you see a captcha solved on *every* reconnect, something is wrong — please
  open an issue.

## [2.1.1] - 2026-08-31

### Fixed

- Connection failures were logged as `Connection attempt failed: [object Object]`,
  hiding the actual cause. The real error message is now shown.

### Changed

- Stopped attempting a token refresh that could not succeed, which was adding a
  failed request to every reconnect.

## [2.1.0] - 2026-08-31

### Fixed

- **The plugin no longer crashes the child bridge in a loop.** A startup failure
  produced an unhandled promise rejection, which killed the child bridge with
  exit code 1; Homebridge restarted the plugin, which solved another captcha,
  and repeated. This was the cause of unexpectedly large 2Captcha bills. Thanks
  to [@AmSach] for finding and fixing the root cause. ([#10])
- **The WebSocket connected to the wrong host.** Sign-in succeeded and then the
  connection was refused, so a captcha was paid for on every failed attempt.
  Thanks to the reporter of [#12] for a very thorough diagnosis.
- **Commands issued while offline are no longer lost.** Queued commands were
  stored one per device, so asking for a mode change discarded the power-on that
  had to come first, and the unit came back still switched off.
- Removed a debug log that grew without limit in the Homebridge storage folder.
  On at least one system it passed 10MB and silently broke nightly backups. If
  you have a large `cielo-debug.log`, it is safe to delete. Detailed logging is
  now opt-in via `CIELO_DEBUG=1`.

### Changed

- Reconnect now backs off (30s, doubling to a 30 minute maximum) instead of
  retrying every 30 seconds, and a burst of errors causes a single reconnect
  rather than several at once.
- The plugin now stops and tells you when retrying cannot help — an exhausted
  2Captcha balance or an invalid API key — instead of retrying and spending
  money it cannot use.
- Plugin log output is now attributed to the plugin and respects your Homebridge
  log level.
- Declared support for Homebridge 2.x (verified against 2.4.0).

### Removed

- `homebridge-config-ui-x` was listed as a dependency. It was never used and
  pulled roughly 14MB into every install.

## [2.0.5] – [2.0.7]

Published to npm but never committed, and the sources were subsequently lost.
They introduced connection-state tracking and an offline command queue, both of
which are preserved in 2.1.0 and later, reconstructed from the published build.

## [2.0.4] and earlier

Temperature-unit auto-detection, a power-off fix, automatic device discovery when
no MAC addresses are configured, and the move to captcha-based authentication.

[2.2.0]: https://github.com/ryanfroese/homebridge-smartcielo/releases/tag/v2.2.0
[2.1.1]: https://github.com/ryanfroese/homebridge-smartcielo/releases/tag/v2.1.1
[2.1.0]: https://github.com/ryanfroese/homebridge-smartcielo/releases/tag/v2.1.0
[#7]: https://github.com/ryanfroese/homebridge-smartcielo/issues/7
[#10]: https://github.com/ryanfroese/homebridge-smartcielo/issues/10
[#12]: https://github.com/ryanfroese/homebridge-smartcielo/issues/12
[@AmSach]: https://github.com/AmSach
