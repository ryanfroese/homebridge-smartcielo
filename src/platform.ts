import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {CieloPlatformAccessory} from './platformAccessory';
import {CieloAPIConnection} from 'node-smartcielo-ws';

/**
 * Connection state tracking
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  /**
   * Stopped permanently. Reached when retrying cannot possibly help - an
   * exhausted 2Captcha balance, a bad API key - so we do not keep spending
   * money or spinning. Requires operator action and a restart.
   */
  FATAL = 'fatal',
}

/**
 * The state a device should be in, accumulated while the connection is down.
 *
 * Deliberately a desired state rather than a list of commands: HomeKit may
 * send several intents while offline ("on", then "heat", then 22 degrees) and
 * replaying them all is both slower and racier than simply converging on the
 * last thing the user asked for. Merging also fixed a bug in the previous
 * queue, which was keyed by MAC and held one action, so queueing a mode change
 * silently discarded the power-on that had to precede it.
 */
interface DesiredState {
  power?: 'on' | 'off';
  mode?: string;
  temperature?: string;
  timestamp: number;
  retryCount: number;
}

// Reconnect backoff. Starts where the old fixed delay was and doubles up to a
// ceiling, so a persistent outage settles into occasional retries instead of
// hammering the API - and, when a captcha is genuinely needed, buying a solve
// every 30 seconds around the clock.
const RECONNECT_BASE_MS = 30 * 1000;
const RECONNECT_MAX_MS = 30 * 60 * 1000;

/**
 * Render any thrown value as something a human can act on.
 *
 * `String(err)` on a plain object yields "[object Object]", which is exactly
 * what the API client used to reject with - so real failures were logged with
 * their cause erased. Anything that is not an Error gets serialized instead.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object') {
    const maybe = err as {message?: unknown; code?: unknown; error?: unknown};
    if (typeof maybe.message === 'string') {
      return maybe.code ? `${maybe.code}: ${maybe.message}` : maybe.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class CieloHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  // Store the API connection
  public hvacAPI: CieloAPIConnection;

  // Connection state tracking
  public connectionState: ConnectionState = ConnectionState.DISCONNECTED;

  // Desired device state accumulated while disconnected, keyed by MAC
  private commandQueue: Map<string, DesiredState> = new Map();

  // Max retry attempts and command expiration
  private readonly MAX_RETRIES = 3;
  private readonly COMMAND_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes

  // Reconnect bookkeeping. The timer handle is the guard that keeps
  // overlapping error reports from scheduling several reconnects at once -
  // each of which could buy its own captcha solve.
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private shuttingDown = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    // Initialize the API connection
    this.hvacAPI = new CieloAPIConnection(
      (commandedState) => {
        this.log.debug(
          'Commanded State Change:',
          JSON.stringify(commandedState),
        );
      },
      (roomTemperature) => {
        this.log.info('Updated Room Temperature:', roomTemperature);
      },
      (err) => {
        this.log.error('Communication Error:', err);
        this.handleConnectionLoss();
      },
    );

    // Route the library's output through the Homebridge logger so it is
    // attributed to this plugin and honours the configured log level, instead
    // of being written straight to the host's stdout.
    this.hvacAPI.setLogger?.(this.log);

    this.log.debug('Finished initializing platform');

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      // This listener is async, and `.on()` discards the promise it returns.
      // Without this catch any rejection became an UnhandledPromiseRejection,
      // which terminated the child bridge with exit code 1; Homebridge then
      // restarted the plugin, which bought another captcha solve, and round it
      // went. See issue #10.
      try {
        await this.connect();
      } catch (err) {
        this.handleConnectFailure(err);
      }
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    });
  }

  /**
   * Authenticate, subscribe and register accessories.
   *
   * The underlying client spends a stored refresh token when it has one, so
   * this only costs a captcha solve on a genuinely cold start.
   */
  private async connect(): Promise<void> {
    this.connectionState = ConnectionState.CONNECTING;
    this.log.debug('Connecting to Cielo API...');

    await this.hvacAPI.establishConnectionWithAutoSolve(
      this.config.username,
      this.config.password,
      this.config.ip,
      undefined,
      {apiKey: this.config.twocaptcha_api_key},
    );

    // Subscribe to HVACs (auto-discovers all devices if macAddresses not specified)
    await this.hvacAPI.subscribeToHVACs(this.config.macAddresses);

    // run the method to discover / register your devices as accessories
    this.discoverDevices();

    this.connectionState = ConnectionState.CONNECTED;
    this.reconnectAttempts = 0;
    this.log.info('Connected to Cielo API');

    await this.processCommandQueue();
  }

  /**
   * Called when the connection drops. Schedules exactly one reconnect.
   */
  private handleConnectionLoss() {
    if (this.connectionState === ConnectionState.FATAL || this.shuttingDown) {
      return;
    }

    this.connectionState = ConnectionState.DISCONNECTED;

    // Already waiting to reconnect. Without this guard, a burst of errors
    // would schedule a reconnect each, and every one of them could buy its
    // own captcha solve.
    if (this.reconnectTimer) {
      this.log.debug('Reconnect already scheduled; ignoring duplicate error.');
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    this.log.error(
      `Reconnecting in ${Math.round(delay / 1000)}s ` +
        `(attempt ${this.reconnectAttempts})...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
      } catch (err) {
        this.handleConnectFailure(err);
      }
    }, delay);

    // Do not hold the event loop open purely to retry a dead connection.
    this.reconnectTimer.unref?.();
  }

  /**
   * Decide whether a failed connection attempt is worth retrying.
   */
  private handleConnectFailure(err: unknown) {
    const message = describeError(err);

    // Some failures cannot be fixed by waiting: an exhausted 2Captcha balance,
    // a wrong or banned key. Retrying those burns money the moment the account
    // is topped up again, so stop and tell the operator instead.
    if (this.isPermanentFailure(err)) {
      this.connectionState = ConnectionState.FATAL;
      this.log.error('Cannot connect to Cielo, and retrying will not help:', message);
      this.log.error(
        'The plugin has stopped trying. Fix the problem above and restart ' +
          'Homebridge (or this child bridge) to try again.',
      );
      return;
    }

    this.log.error('Connection attempt failed:', message);
    this.handleConnectionLoss();
  }

  private isPermanentFailure(err: unknown): boolean {
    if (!err) {
      return false;
    }
    if ((err as {permanent?: boolean}).permanent === true) {
      return true;
    }
    const message = describeError(err);
    return (
      message.includes('ERROR_ZERO_BALANCE') ||
      message.includes('ERROR_WRONG_USER_KEY') ||
      message.includes('ERROR_KEY_DOES_NOT_EXIST') ||
      message.includes('TWOCAPTCHA_API_KEY not configured')
    );
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of this.hvacAPI.hvacs) {
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.getMacAddress());

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid,
      );

      if (existingAccessory) {
        // the accessory already exists
        this.log.info(
          'Restoring existing accessory from cache:',
          existingAccessory.displayName,
        );

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        new CieloPlatformAccessory(this, existingAccessory, device);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.getDeviceName());

        // create a new accessory
        const accessory = new this.api.platformAccessory(
          device.getDeviceName(),
          uuid,
        );

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        new CieloPlatformAccessory(this, accessory, device);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }
  }

  /**
   * Record what a device should look like once the connection is back.
   *
   * Fields merge, so a power-on followed by a mode change yields both rather
   * than the mode change replacing the power-on.
   */
  queueDesiredState(deviceMac: string, desired: Partial<Omit<DesiredState, 'timestamp' | 'retryCount'>>) {
    const existing = this.commandQueue.get(deviceMac);
    const merged: DesiredState = {
      ...existing,
      ...desired,
      timestamp: Date.now(),
      retryCount: existing?.retryCount ?? 0,
    };
    this.commandQueue.set(deviceMac, merged);
    this.log.info(
      `Queued state for ${deviceMac} while offline ` +
        `(${this.describeDesiredState(merged)}); queue size ${this.commandQueue.size}`,
    );
  }

  private describeDesiredState(state: DesiredState): string {
    const parts: string[] = [];
    if (state.power) {
      parts.push(`power=${state.power}`);
    }
    if (state.mode) {
      parts.push(`mode=${state.mode}`);
    }
    if (state.temperature) {
      parts.push(`temp=${state.temperature}`);
    }
    return parts.length > 0 ? parts.join(' ') : 'no-op';
  }

  /**
   * Apply everything queued while the connection was down.
   */
  async processCommandQueue() {
    if (this.commandQueue.size === 0) {
      this.log.debug('No queued state to apply');
      return;
    }

    this.log.info(`Applying queued state for ${this.commandQueue.size} device(s)`);

    const now = Date.now();

    for (const [deviceMac, desired] of this.commandQueue.entries()) {
      if (now - desired.timestamp > this.COMMAND_EXPIRATION_MS) {
        this.log.warn(`Queued state for ${deviceMac} expired - discarding`);
        this.commandQueue.delete(deviceMac);
        continue;
      }

      if (desired.retryCount >= this.MAX_RETRIES) {
        this.log.error(`Queued state for ${deviceMac} exceeded retry limit - giving up`);
        this.commandQueue.delete(deviceMac);
        continue;
      }

      const hvac = this.hvacAPI.hvacs.find((h) => h.getMacAddress() === deviceMac);
      if (!hvac) {
        this.log.warn(`Device ${deviceMac} not found - discarding queued state`);
        this.commandQueue.delete(deviceMac);
        continue;
      }

      try {
        this.log.info(
          `Applying ${this.describeDesiredState(desired)} to ${deviceMac} ` +
            `(attempt ${desired.retryCount + 1})`,
        );

        // Order matters: the unit ignores a mode or temperature change while
        // it is powered off, so power goes first.
        if (desired.power === 'off') {
          await hvac.powerOff(this.hvacAPI);
        } else {
          if (desired.power === 'on') {
            await hvac.powerOn(this.hvacAPI);
          }
          if (desired.mode) {
            await hvac.setMode(desired.mode, this.hvacAPI);
          }
          if (desired.temperature) {
            await hvac.setTemperature(desired.temperature, this.hvacAPI);
          }
        }

        this.log.info(`Applied queued state for ${deviceMac}`);
        this.commandQueue.delete(deviceMac);
      } catch (error) {
        desired.retryCount++;
        this.commandQueue.set(deviceMac, desired);
        this.log.error(`Failed to apply queued state for ${deviceMac}:`, error);
      }
    }
  }
}
