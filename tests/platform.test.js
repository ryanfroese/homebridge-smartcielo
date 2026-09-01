#!/usr/bin/env node
/* eslint-disable */

/*
 * Behavioural tests for the reconnect and offline-queue logic in
 * src/platform.ts, driven against the compiled dist/ output.
 *
 * These cover the defects that cost real money and real device commands:
 *
 *   - issue #10: an async `didFinishLaunching` listener whose rejection was
 *     never caught killed the child bridge, so Homebridge restarted the plugin
 *     and bought another captcha solve, forever.
 *   - a burst of connection errors used to schedule one reconnect each, and
 *     every reconnect could buy its own captcha solve.
 *   - ERROR_ZERO_BALANCE was retried indefinitely, which re-drains a balance
 *     the moment it is topped up.
 *   - the old queue was keyed by MAC and held a single action, so queueing a
 *     mode change silently discarded the power-on that had to precede it.
 *
 * Run with: npm test
 */

const assert = require('assert');
const EventEmitter = require('events');

const {CieloHomebridgePlatform, ConnectionState} = require('../dist/platform');

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n         ${err.stack || err.message}`);
  }
}

function makeLog() {
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    text: () => lines.join('\n'),
  };
}

/** Minimal stand-in for the Homebridge API surface the platform touches. */
function makeHomebridgeApi() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    hap: {
      Service: {},
      Characteristic: {},
      uuid: {generate: (s) => `uuid-${s}`},
    },
    platformAccessory: function (name, uuid) {
      this.displayName = name;
      this.UUID = uuid;
      this.getService = () => undefined;
      this.addService = () => ({setCharacteristic: () => {}});
    },
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
  };
}

/**
 * Builds a platform with the network layer stubbed out. `establish` controls
 * what the captcha/login step does on each call.
 */
function makePlatform(establish, options = {}) {
  const log = makeLog();
  const api = makeHomebridgeApi();
  const calls = {establish: 0, subscribe: 0};

  const OriginalConnection = require('node-smartcielo-ws').CieloAPIConnection;
  const stub = {
    hvacs: options.hvacs || [],
    setLogger() {},
    async establishConnectionWithAutoSolve() {
      calls.establish++;
      return establish(calls.establish);
    },
    async subscribeToHVACs() {
      calls.subscribe++;
    },
  };

  // The platform constructs its own CieloAPIConnection; swap the field after.
  const platform = new CieloHomebridgePlatform(log, {
    username: 'u',
    password: 'p',
    ip: '1.2.3.4',
    twocaptcha_api_key: 'k',
  }, api);
  platform.hvacAPI = stub;

  return {platform, log, api, calls, stub, OriginalConnection};
}

/*
 * The crash that started all of this: didFinishLaunching is registered with
 * .on(), which discards the returned promise. A rejection there used to become
 * an UnhandledPromiseRejection and take the child bridge down with exit 1.
 */
async function testLaunchFailureDoesNotReject() {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  try {
    const {api, log} = makePlatform(() => Promise.reject(new Error('login exploded')));
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(
      rejections.length,
      0,
      'a failing startup must not produce an unhandled rejection - that is ' +
        'what killed the child bridge and restarted the captcha loop (issue #10)'
    );
    assert.ok(
      /login exploded/.test(log.text()),
      'the underlying failure should still be logged, not swallowed silently'
    );
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
}

/*
 * A failing socket can report several errors in quick succession. Each one used
 * to schedule its own reconnect, and each reconnect could buy a captcha.
 */
async function testBurstOfErrorsSchedulesOneReconnect() {
  const {platform, log} = makePlatform(() => Promise.resolve());

  platform.connectionState = ConnectionState.CONNECTED;

  // Five errors arriving back to back, as a flapping socket would produce.
  for (let i = 0; i < 5; i++) {
    platform.handleConnectionLoss();
  }

  const scheduled = log.lines.filter((l) => /Reconnecting in/.test(l));
  assert.strictEqual(
    scheduled.length,
    1,
    `scheduled ${scheduled.length} reconnects for one outage; each one can buy ` +
      'a captcha solve, so bursts must collapse into a single attempt'
  );
}

/* Backoff must actually grow, or a long outage retries every 30s forever. */
async function testReconnectBackoffGrows() {
  const {platform, log} = makePlatform(() => Promise.resolve());
  const delays = [];

  for (let i = 0; i < 4; i++) {
    platform.reconnectTimer = undefined; // simulate the prior timer having fired
    platform.connectionState = ConnectionState.CONNECTED;
    platform.handleConnectionLoss();
    const line = log.lines.filter((l) => /Reconnecting in/.test(l)).pop();
    delays.push(parseInt(/Reconnecting in (\d+)s/.exec(line)[1], 10));
  }

  assert.deepStrictEqual(
    delays,
    [30, 60, 120, 240],
    `expected exponential backoff, got ${delays.join(', ')}`
  );

  // Clean up the pending timers so the test process can exit.
  if (platform.reconnectTimer) {
    clearTimeout(platform.reconnectTimer);
  }
}

/*
 * ERROR_ZERO_BALANCE was observed looping on a live host. Retrying it cannot
 * help, and will re-drain the account as soon as it is funded.
 */
async function testZeroBalanceStopsRetrying() {
  const zeroBalance = Object.assign(
    new Error('2Captcha submission failed: ERROR_ZERO_BALANCE - top up'),
    {permanent: true}
  );
  const {platform, log} = makePlatform(() => Promise.reject(zeroBalance));

  platform.handleConnectFailure(zeroBalance);

  assert.strictEqual(
    platform.connectionState,
    ConnectionState.FATAL,
    'an exhausted captcha balance must move the plugin to FATAL, not retry'
  );
  assert.strictEqual(
    platform.reconnectTimer,
    undefined,
    'no reconnect may be scheduled after a permanent failure'
  );
  assert.ok(
    /stopped trying/.test(log.text()),
    'the operator must be told the plugin has given up and why'
  );
}

/* A transient failure, by contrast, must still schedule a retry. */
async function testTransientFailureStillRetries() {
  const {platform, log} = makePlatform(() => Promise.reject(new Error('ETIMEDOUT')));

  platform.handleConnectFailure(new Error('ETIMEDOUT'));

  assert.notStrictEqual(
    platform.connectionState,
    ConnectionState.FATAL,
    'a network timeout is transient and must not stop the plugin permanently'
  );
  assert.ok(
    /Reconnecting in/.test(log.text()),
    'a transient failure should schedule another attempt'
  );

  if (platform.reconnectTimer) {
    clearTimeout(platform.reconnectTimer);
  }
}

/*
 * The old queue held one action per MAC, so this sequence lost the power-on
 * and the unit came back still off.
 */
async function testQueueMergesPowerAndMode() {
  const {platform} = makePlatform(() => Promise.resolve());

  platform.queueDesiredState('AABBCCDDEEFF', {power: 'on'});
  platform.queueDesiredState('AABBCCDDEEFF', {mode: 'heat'});
  platform.queueDesiredState('AABBCCDDEEFF', {temperature: '72'});

  const queued = platform.commandQueue.get('AABBCCDDEEFF');
  assert.strictEqual(queued.power, 'on', 'the power-on must survive later intents');
  assert.strictEqual(queued.mode, 'heat', 'the mode must be retained');
  assert.strictEqual(queued.temperature, '72', 'the temperature must be retained');
}

/* Applying queued state must power on before setting mode or temperature. */
async function testQueueAppliesPowerFirst() {
  const order = [];
  const hvac = {
    getMacAddress: () => 'AABBCCDDEEFF',
    getDeviceName: () => 'Office',
    powerOn: async () => order.push('powerOn'),
    powerOff: async () => order.push('powerOff'),
    setMode: async (m) => order.push(`setMode:${m}`),
    setTemperature: async (t) => order.push(`setTemperature:${t}`),
  };

  const {platform} = makePlatform(() => Promise.resolve(), {hvacs: [hvac]});
  platform.hvacAPI.hvacs = [hvac];

  platform.queueDesiredState('AABBCCDDEEFF', {power: 'on', mode: 'heat', temperature: '72'});
  await platform.processCommandQueue();

  assert.deepStrictEqual(
    order,
    ['powerOn', 'setMode:heat', 'setTemperature:72'],
    `commands applied in the wrong order (${order.join(', ')}); the unit ignores ` +
      'mode and temperature while powered off'
  );
  assert.strictEqual(platform.commandQueue.size, 0, 'applied state must leave the queue');
}

/* Powering off should not also send a mode or temperature. */
async function testQueuePowerOffSkipsOtherCommands() {
  const order = [];
  const hvac = {
    getMacAddress: () => 'AABBCCDDEEFF',
    getDeviceName: () => 'Office',
    powerOn: async () => order.push('powerOn'),
    powerOff: async () => order.push('powerOff'),
    setMode: async (m) => order.push(`setMode:${m}`),
    setTemperature: async (t) => order.push(`setTemperature:${t}`),
  };

  const {platform} = makePlatform(() => Promise.resolve(), {hvacs: [hvac]});
  platform.hvacAPI.hvacs = [hvac];

  platform.queueDesiredState('AABBCCDDEEFF', {mode: 'heat'});
  platform.queueDesiredState('AABBCCDDEEFF', {power: 'off'});
  await platform.processCommandQueue();

  assert.deepStrictEqual(
    order,
    ['powerOff'],
    `expected only a power-off, got (${order.join(', ')})`
  );
}

/*
 * The API client used to reject with a bare object, which String()'d to
 * "[object Object]" - a real connection failure was logged with its cause
 * erased, which cost a debugging round-trip against a live host.
 */
async function testNonErrorRejectionIsReadable() {
  const {platform, log} = makePlatform(() => Promise.resolve());

  platform.handleConnectFailure({code: 401, message: 'Unauthorized'});
  platform.handleConnectFailure({weird: 'shape', nested: {a: 1}});

  const text = log.text();
  assert.ok(
    !/\[object Object\]/.test(text),
    'a non-Error rejection must never be logged as "[object Object]"'
  );
  assert.ok(
    /401: Unauthorized/.test(text),
    `expected the API code and message to survive; got:\n${text}`
  );
  assert.ok(
    /weird/.test(text),
    'an unrecognised object shape should still be serialized, not erased'
  );

  if (platform.reconnectTimer) {
    clearTimeout(platform.reconnectTimer);
  }
}

/*
 * Homebridge verification requires that a plugin "must successfully install and
 * not start unless it is configured". Beyond the rule, an unconfigured start
 * would pay for a captcha solve only to discover it has no credentials.
 */
async function testDoesNotStartWhenUnconfigured() {
  const log = makeLog();
  const api = makeHomebridgeApi();
  let connectAttempted = false;

  const platform = new CieloHomebridgePlatform(log, {platform: 'cielo'}, api);
  platform.hvacAPI = {
    hvacs: [], setLogger() {},
    async establishConnectionWithAutoSolve() { connectAttempted = true; },
    async subscribeToHVACs() {},
  };

  api.emit('didFinishLaunching');
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(connectAttempted, false,
    'an unconfigured plugin must not attempt to connect - doing so buys a captcha to learn nothing');
  assert.strictEqual(platform.connectionState, ConnectionState.FATAL,
    'an unconfigured plugin should settle in FATAL rather than retrying');
  assert.ok(/not configured/i.test(log.text()),
    'the operator must be told which settings are missing');
  assert.ok(/Username|Password|2Captcha/.test(log.text()),
    'the message should name the missing settings');
}

async function testStartsWhenFullyConfigured() {
  const {platform, api, calls} = makePlatform(() => Promise.resolve());
  api.emit('didFinishLaunching');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.establish > 0, 'a fully configured plugin must still connect');
  if (platform.reconnectTimer) {
    clearTimeout(platform.reconnectTimer);
  }
}

(async () => {
  console.log('platform reconnect/queue tests\n');
  await check('startup failure does not crash the bridge (issue #10)', testLaunchFailureDoesNotReject);
  await check('does not start when unconfigured', testDoesNotStartWhenUnconfigured);
  await check('does start when fully configured', testStartsWhenFullyConfigured);
  await check('error burst schedules a single reconnect', testBurstOfErrorsSchedulesOneReconnect);
  await check('reconnect backoff grows exponentially', testReconnectBackoffGrows);
  await check('zero captcha balance stops retrying', testZeroBalanceStopsRetrying);
  await check('transient failure still retries', testTransientFailureStillRetries);
  await check('non-Error rejections are readable', testNonErrorRejectionIsReadable);
  await check('offline queue merges power and mode', testQueueMergesPowerAndMode);
  await check('queued state applies power before mode', testQueueAppliesPowerFirst);
  await check('queued power-off skips mode and temperature', testQueuePowerOffSkipsOtherCommands);

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll tests passed.');
  process.exit(0);
})();
