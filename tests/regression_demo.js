#!/usr/bin/env node
/* eslint-disable */

/*
 * Regression demo for issue #10.
 *
 * The original code shape in src/platform.ts:
 *
 *   this.api.on('didFinishLaunching', async () => {
 *     await this.hvacAPI.establishConnectionWithAutoSolve(...);
 *     await this.hvacAPI.subscribeToHVACs(...);
 *     // ... NOTE: any throw => unhandled rejection => process crash
 *   });
 *
 * EventEmitter listeners attached via .on() return the emitter, not the
 * promise. If the async callback throws, the promise is left dangling
 * unless the listener explicitly .catch()es it.
 *
 * This demo shows that:
 *   1. The BROKEN shape produces an unhandled-rejection event.
 *   2. The FIXED shape silently logs and recovers.
 */

process.on('unhandledRejection', (reason) => {
  console.log('!!! UNHANDLED REJECTION DETECTED:', reason && reason.message);
  process.exitCode = 1;
});

function runBroken(establish, subscribe) {
  // Async function assigned as an .on() listener is the offending shape:
  //   const ret = emitter.on('evt', async () => { await establish(); await subscribe(); });
  // .on() returns the emitter, and any throw inside the async fn becomes unhandled.
  const emitter = new (require('events').EventEmitter)();
  emitter.on('event', async () => {
    await establish();
    await subscribe();
  });
  return emitter.emit('event');
}

function runFixed(establish, subscribe, log) {
  const emitter = new (require('events').EventEmitter)();
  emitter.on('event', async () => {
    try {
      await establish();
      await subscribe();
    } catch (err) {
      log.error('Failed to connect to HVAC API (startup):', err);
    }
  });
  return emitter.emit('event');
}

(async () => {
  const failingEstablish = () => Promise.reject(new Error('captcha balance exhausted'));
  const failingSubscribe = () => Promise.reject(new Error('ws timeout'));

  console.log('--- BROKEN path ---');
  process.exitCode = 0;
  runBroken(failingEstablish, failingSubscribe);
  await new Promise((r) => setTimeout(r, 50));

  console.log('--- FIXED path ---');
  process.exitCode = 0;
  const logger = {error: (msg, e) => console.log('  [log.error]', msg, e.message)};
  runFixed(failingEstablish, failingSubscribe, logger);
  await new Promise((r) => setTimeout(r, 50));
  console.log('Done.');
})();
