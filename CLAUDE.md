# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Homebridge plugin that enables HomeKit control of Cielo mini-split thermostats. The plugin connects to Cielo's cloud API using WebSocket communication via the `node-smartcielo-ws` package.

**Plugin Identifiers:**
- Platform name: `cielo` (used in Homebridge config.json)
- Plugin name: `homebridge-cielo` (npm package name)

**Requirements:**
- Node.js: Version 18.0.0 or higher (tested with Node.js 22)
- Homebridge: Version 1.3.5 or higher

## Build and Development Commands

```bash
# Build the plugin (compiles TypeScript to dist/)
npm run build

# Lint code (must have zero warnings)
npm run lint

# Watch mode - auto-rebuild and restart Homebridge on changes
npm run watch

# Pre-publish (runs lint + build)
npm run prepublishOnly
```

**Note:** The watch command uses nodemon to monitor `src/` and executes `tsc && homebridge -I -D` on changes. It also uses `npm link` to symlink the plugin for local testing.

## Architecture Overview

### Core Components

**1. Platform (`src/platform.ts` - `CieloHomebridgePlatform`)**
- Main entry point implementing Homebridge's `DynamicPlatformPlugin`
- Manages the WebSocket connection to Cielo API via `CieloAPIConnection`
- Handles device discovery and registration
- Implements automatic reconnection on communication errors (30s delay)
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
- Communication errors trigger automatic reconnection after 30 seconds
- The error callback re-establishes connection and re-subscribes to all devices

**Command Sequencing:**
- When powering on AND changing mode: power on first, wait 10 seconds, then set mode
- This hard-coded delay exists due to API limitations (see TODO at `src/platformAccessory.ts:118`)

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
- `macAddresses`: Array of HVAC MAC addresses (12 uppercase hex chars, no colons)

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

**Cost:** Approximately $0.003 per captcha solve. The plugin only reconnects on actual connection failures (not token expiration), so typical monthly cost is very low:
- **Stable connection:** $0.01-0.05/month (1-15 reconnects/month for network issues)
- **Unstable connection:** $0.10-0.30/month (more frequent network drops)

The WebSocket connection stays alive even after the access token expires, so you're not being charged hourly as you might expect.

## Code Style

- TypeScript with `strict: true` (except `noImplicitAny: false`)
- ESLint configured for Homebridge standards
- Single quotes, 2-space indentation
- Max line length: 140 characters
- Use Homebridge's logger, never `console.log`
- Semicolons required (enforced by `@typescript-eslint/semi`)

## Dependencies

**Runtime:**
- `node-smartcielo-ws`: WebSocket API client for Cielo devices
- `homebridge-config-ui-x`: Homebridge UI integration

**Note:** This plugin depends on `node-smartcielo-ws` which is a custom rewrite of the original Cielo API package. Changes to that package may affect this plugin's functionality.
