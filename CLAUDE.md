# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Homebridge plugin that enables HomeKit control of Cielo mini-split thermostats. The plugin connects to Cielo's cloud API using WebSocket communication via the `node-smartcielo-ws` package.

**Plugin Identifiers:**
- Platform name: `cielo` (used in Homebridge config.json)
- Plugin name: `homebridge-cielo` (npm package name)

**Requirements:**
- Node.js: Version 18.20+, 20.18+, or 22.10+
- Homebridge: v1.6.0 or v2.x (verified against Homebridge 2.4.0)

## Build and Development Commands

```bash
# Build the plugin (compiles TypeScript to dist/)
npm run build

# Lint code (must have zero warnings)
npm run lint

# Watch mode - auto-rebuild and restart Homebridge on changes
npm run watch

# Run the reconnect/queue regression tests (builds first)
npm test

# Pre-publish (runs lint + build + tests)
npm run prepublishOnly
```

**Publishing:** this package and its dependency `node-smartcielo-ws` (repo:
`node-cielo`) are published to npm, which is how updates reach users. Publish
the library first, then bump the plugin's dependency range and publish it.
Always commit before publishing - versions 2.0.5 through 2.0.7 were published
without being committed and the TypeScript sources were lost, requiring
reconstruction from the published `dist/`.

**Note:** The watch command uses nodemon to monitor `src/` and executes `tsc && homebridge -I -D` on changes. It also uses `npm link` to symlink the plugin for local testing.

## Architecture Overview

### Core Components

**1. Platform (`src/platform.ts` - `CieloHomebridgePlatform`)**
- Main entry point implementing Homebridge's `DynamicPlatformPlugin`
- Manages the WebSocket connection to Cielo API via `CieloAPIConnection`
- Handles device discovery and registration
- Reconnects on communication errors with exponential backoff (30s doubling to
  a 30 minute ceiling), guarded so a burst of errors schedules only one attempt
- Stops permanently (`ConnectionState.FATAL`) on failures retrying cannot fix,
  such as an exhausted 2Captcha balance or a bad API key
- Key responsibilities:
  - Establishes connection on `didFinishLaunching` event
  - Subscribes to all configured HVAC units by MAC address
  - Discovers and registers accessories (or restores from cache)

**2. Platform Accessory (`src/platformAccessory.ts` - `CieloPlatformAccessory`)**
- Represents individual HVAC units as HomeKit Thermostat accessories
- Each accessory wraps a `CieloHVAC` instance from `node-smartcielo-ws`
- Exposes HomeKit Thermostat service with characteristics:
  - Current/Target Heating/Cooling State
  - Current/Target Temperature
  - Temperature Display Units
- Handles temperature conversion (Fahrenheit ↔ Celsius)
- Implements command optimization (skips redundant commands)

**3. Settings (`src/settings.ts`)**
- Exports platform and plugin name constants

### Key Implementation Details

**Connection Flow:**
1. Platform constructor initializes `CieloAPIConnection` with callbacks for state changes, temperature updates, and errors
2. On `didFinishLaunching`, establishes connection using credentials from config
3. Subscribes to all HVAC units listed in `macAddresses` array
4. Discovers devices and creates/restores accessories

**Error Handling:**
- The `didFinishLaunching` listener is async and registered with `.on()`, which
  discards its promise. It MUST keep its try/catch: an uncaught rejection there
  terminates the child bridge with exit code 1, Homebridge restarts the plugin,
  and each restart buys another captcha solve (issue #10).
- Communication errors schedule a single reconnect with exponential backoff.
  `reconnectTimer` is the guard that stops concurrent reconnects, each of which
  could buy its own captcha solve.
- Permanent failures (zero 2Captcha balance, bad key) move the platform to
  `FATAL` and stop retrying, so a topped-up balance is not immediately drained.

**Offline Command Queue:**
- Commands issued while disconnected are stored per device as a *desired state*
  (`power` / `mode` / `temperature`) rather than a list of actions, and merge.
  The previous queue held one action per MAC, so queueing a mode change
  discarded the power-on that had to precede it.
- On reconnect the queue applies power first, since the unit ignores mode and
  temperature changes while it is off. Entries expire after 5 minutes and give
  up after 3 attempts.

**Command Sequencing:**
- When powering on AND changing mode: power on first, wait 10 seconds, then set mode
- This hard-coded delay exists due to API limitations (see the TODO in
  `setTargetHeatingCoolingState`)

**Temperature Handling:**
- API uses Fahrenheit internally
- HomeKit uses Celsius
- Target temperature clamped to 62-86°F range
- Conversions use proper rounding (Celsius rounded to 1 decimal place)

## Configuration

The plugin requires configuration via Homebridge UI or config.json:
- `username`: Cielo account email
- `password`: Cielo account password
- `ip`: Public IP address (used as session identifier, despite the name)
- `macAddresses`: **Optional.** Array of HVAC MAC addresses (12 uppercase hex
  chars, no colons). Leave empty to auto-discover every HVAC on the account.

Schema defined in `config.schema.json` with validation pattern: `^[A-F0-9]{12}$`

**IMPORTANT:** Since version 2.0.0, the plugin requires a 2Captcha API key configured in Homebridge settings (or config.json):

```json
{
  "platform": "cielo",
  "twocaptcha_api_key": "your-api-key-here",
  "username": "...",
  "password": "...",
  "ip": "...",
  "macAddresses": [...]
}
```

This is required because Cielo's API now uses reCAPTCHA v2 for authentication. The plugin automatically solves captchas using the 2Captcha service.

**Cost:** Approximately $0.003 per captcha solve. Since v2.2.0 the library logs
in as an iOS client, which makes the refresh endpoint work, so a reconnect
costs nothing. A healthy install solves **once**, not once per reconnect.

Verified end to end: four consecutive connections, one captcha solve total.

The WebSocket connection stays alive even after the access token expires, so
you're not being charged hourly as you might expect.

**If costs spike, look for a loop.** Every historical case traced back to a
connection that could never succeed, combined with an unguarded retry. Two
such causes are now fixed: the WebSocket host was wrong (issue #12), and the
client logged in as `WEB`, whose tokens Cielo's own servers reject. See
`API_STATUS.md` in the node-cielo repo before touching auth.

## Code Style

- TypeScript with `strict: true` (except `noImplicitAny: false`)
- ESLint configured for Homebridge standards
- Single quotes, 2-space indentation
- Max line length: 140 characters
- Use Homebridge's logger, never `console.log`
- Semicolons required (enforced by `@typescript-eslint/semi`)

## Dependencies

**Runtime:**
- `node-smartcielo-ws`: WebSocket API client for Cielo devices (repo: `node-cielo`)

`homebridge-config-ui-x` was previously listed as a runtime dependency. It was
never imported, and it pulled ~14MB into every install; it was removed in
v2.1.0. Plugins do not depend on the Homebridge UI.

**Note:** This plugin depends on `node-smartcielo-ws` which is a custom rewrite of the original Cielo API package. Changes to that package may affect this plugin's functionality.
