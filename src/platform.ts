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
}

/**
 * A command that could not be delivered because the connection was down, held
 * until the connection is restored.
 */
interface QueuedCommand {
  deviceMac: string;
  action: 'powerOn' | 'powerOff' | 'setMode' | 'setTemperature';
  parameters?: {
    mode?: string;
    temperature?: string;
  };
  timestamp: number;
  retryCount: number;
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

  // Command queue (keyed by device MAC to keep only latest command per device)
  private commandQueue: Map<string, QueuedCommand> = new Map();

  // Max retry attempts and command expiration
  private readonly MAX_RETRIES = 3;
  private readonly COMMAND_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes

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
        // Only reconnects on ACTUAL communication errors, not token expiration
        // WebSocket connection stays alive much longer than token expiry
        // This minimizes captcha costs - typically only reconnects if internet drops
        this.log.error('Communication Error:', err);
        this.connectionState = ConnectionState.DISCONNECTED;
        this.log.error('Reconnecting in 30 seconds...');
        setTimeout(async () => {
          this.connectionState = ConnectionState.CONNECTING;
          this.log.debug('Reconnecting to API with auto-captcha solve...');
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
          // Mark as connected and process queued commands
          this.connectionState = ConnectionState.CONNECTED;
          this.log.info('Connection restored - processing queued commands');
          await this.processCommandQueue();
        }, 30000);
      },
    );

    this.log.debug('Finished initializing platform');

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      this.connectionState = ConnectionState.CONNECTING;
      this.log.debug('Connecting to API with auto-captcha solve...');
      await this.hvacAPI.establishConnectionWithAutoSolve(
        this.config.username,
        this.config.password,
        this.config.ip,
        undefined,
        {apiKey: this.config.twocaptcha_api_key},
      );
      // Subscribe to HVACs (auto-discovers all devices if macAddresses not specified)
      await this.hvacAPI.subscribeToHVACs(this.config.macAddresses);
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
      // Mark as connected
      this.connectionState = ConnectionState.CONNECTED;
      this.log.info('Initial connection established');
    });
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

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        // existingAccessory.context.device = device.getMacAddress();
        // this.api.updatePlatformAccessories([existingAccessory]);

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

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        // accessory.context.device = device;

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
   * Queue a command for retry when connection is restored
   */
  queueCommand(
    deviceMac: string,
    action: QueuedCommand['action'],
    parameters?: QueuedCommand['parameters'],
  ) {
    const command: QueuedCommand = {
      deviceMac,
      action,
      parameters,
      timestamp: Date.now(),
      retryCount: 0,
    };

    // Only keep the latest command per device (user's most recent intent)
    this.commandQueue.set(deviceMac, command);
    this.log.info(
      `Queued ${action} command for device ${deviceMac} (queue size: ${this.commandQueue.size})`,
    );
  }

  /**
   * Process all queued commands after connection is restored
   */
  async processCommandQueue() {
    if (this.commandQueue.size === 0) {
      this.log.debug('No commands in queue');
      return;
    }

    this.log.info(`Processing ${this.commandQueue.size} queued command(s)`);

    const now = Date.now();

    // Process each queued command
    for (const [deviceMac, command] of this.commandQueue.entries()) {
      // Skip expired commands
      if (now - command.timestamp > this.COMMAND_EXPIRATION_MS) {
        this.log.warn(
          `Command ${command.action} for ${deviceMac} expired - skipping`,
        );
        this.commandQueue.delete(deviceMac);
        continue;
      }

      // Skip commands that have exceeded retry limit
      if (command.retryCount >= this.MAX_RETRIES) {
        this.log.error(
          `Command ${command.action} for ${deviceMac} exceeded retry limit - giving up`,
        );
        this.commandQueue.delete(deviceMac);
        continue;
      }

      // Find the HVAC device
      const hvac = this.hvacAPI.hvacs.find(
        (h) => h.getMacAddress() === deviceMac,
      );
      if (!hvac) {
        this.log.warn(`Device ${deviceMac} not found - skipping command`);
        this.commandQueue.delete(deviceMac);
        continue;
      }

      // Execute the command
      try {
        this.log.info(
          `Retrying ${command.action} for ${deviceMac} (attempt ${
            command.retryCount + 1
          })`,
        );

        switch (command.action) {
          case 'powerOn':
            await hvac.powerOn(this.hvacAPI);
            break;
          case 'powerOff':
            await hvac.powerOff(this.hvacAPI);
            break;
          case 'setMode':
            if (command.parameters?.mode) {
              await hvac.setMode(command.parameters.mode, this.hvacAPI);
            }
            break;
          case 'setTemperature':
            if (command.parameters?.temperature) {
              await hvac.setTemperature(
                command.parameters.temperature,
                this.hvacAPI,
              );
            }
            break;
        }

        // Success - remove from queue
        this.log.info(
          `Successfully executed queued ${command.action} for ${deviceMac}`,
        );
        this.commandQueue.delete(deviceMac);
      } catch (error) {
        // Increment retry count
        command.retryCount++;
        this.commandQueue.set(deviceMac, command);
        this.log.error(
          `Failed to execute queued ${command.action} for ${deviceMac}:`,
          error,
        );
      }
    }
  }
}
