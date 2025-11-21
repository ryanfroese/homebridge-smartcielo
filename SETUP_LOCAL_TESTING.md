# Setup Guide for Local Testing with node-cielo v2.0

This guide explains how to test the homebridge-cielo plugin with the local development version of node-smartcielo-ws (node-cielo).

## Prerequisites

1. **2Captcha API Key**: Sign up at https://2captcha.com/ and get your API key
2. **Node.js**: Version 18.0.0 or higher (tested with Node.js 22)
3. **Homebridge**: Version 1.3.5 or higher

## Step 1: Link the local node-cielo package

From the `node-cielo` directory:

```bash
cd /Users/ryanfroese/Files/projects/node-cielo
npm link
```

This makes the local package available globally as `node-smartcielo-ws`.

## Step 2: Link the package to homebridge-cielo

From the `homebridge-smartcielo` directory:

```bash
cd /Users/ryanfroese/Files/projects/homebridge-smartcielo
npm link node-smartcielo-ws
```

This tells npm to use the local version instead of downloading from npm registry.

## Step 3: Build the plugin

```bash
cd /Users/ryanfroese/Files/projects/homebridge-smartcielo
npm run build
```

## Step 4: Configure Homebridge

Add to your `config.json` (including the 2Captcha API key):

```json
{
  "platforms": [
    {
      "platform": "cielo",
      "name": "Cielo",
      "twocaptcha_api_key": "your-2captcha-api-key-here",
      "username": "your-cielo-email@example.com",
      "password": "your-cielo-password",
      "ip": "73.162.98.163",
      "macAddresses": [
        "C45BBEC42467",
        "4855196E799C",
        "C45BBEC4A1BB",
        "E868E7DE4FB1"
      ]
    }
  ]
}
```

**Note:** You can also configure this through the Homebridge Config UI - the 2Captcha API Key field is now part of the plugin configuration.

## Step 5: Test the plugin

### Option A: Run Homebridge directly

```bash
homebridge -I -D
```

This runs Homebridge in insecure mode (-I) with debug logging (-D).

### Option B: Use the watch script

```bash
npm run watch
```

This automatically rebuilds and restarts Homebridge when you make changes to the source code.

## Troubleshooting

### "Cannot find module 'node-smartcielo-ws'"

Make sure you ran `npm link` in both directories:
1. In node-cielo: `npm link`
2. In homebridge-smartcielo: `npm link node-smartcielo-ws`

### "TWOCAPTCHA_API_KEY not configured"

Make sure you've added the `twocaptcha_api_key` field to your config.json or set it in the Homebridge Config UI.

### Captcha solving fails

- Check your 2Captcha balance at https://2captcha.com/
- Each solve costs ~$0.003
- Typical solve time is 10-30 seconds

### Connection errors

Enable debug logging in Homebridge config:

```json
{
  "platforms": [
    {
      "platform": "cielo",
      "name": "Cielo",
      "_bridge": {
        "username": "...",
        "port": 12345
      },
      "username": "...",
      "password": "...",
      "debug": true
    }
  ]
}
```

Check the Homebridge logs for detailed error messages.

## Unlinking (return to npm version)

When you're done testing and want to use the published npm version:

```bash
cd /Users/ryanfroese/Files/projects/homebridge-smartcielo
npm unlink node-smartcielo-ws
npm install node-smartcielo-ws@^2.0.0
```

## Expected Behavior

On startup, you should see:
1. "Connecting to API with auto-captcha solve..."
2. Captcha solving progress (10-30 seconds)
3. "Executed didFinishLaunching callback"
4. Accessories registered in HomeKit
5. Temperature and status updates flowing

The plugin will automatically reconnect if the connection actually drops (network issues, etc.), solving a new captcha only when necessary.

## Cost Monitoring

The plugin only reconnects on actual connection failures, not token expiration:

- **Initial connection:** 1 captcha solve ($0.003)
- **Reconnections:** Only on network/WebSocket failures
- **Typical monthly cost:**
  - Stable connection: $0.01-0.05/month (1-15 reconnects)
  - Unstable connection: $0.10-0.30/month (more frequent drops)
- **Max theoretical cost:** ~$2.16/month (if it reconnected every hour, which it doesn't)

The WebSocket connection stays alive even after access tokens expire, so you're only charged when the connection actually drops (network issues, Homebridge restarts, server disconnects).

Monitor your actual usage at: https://2captcha.com/enterpage
