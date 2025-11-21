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
        this.log.error('Reconnecting in 30 seconds...');
        setTimeout(async () => {
          this.log.debug('Reconnecting to API with auto-captcha solve...');
          await this.hvacAPI.establishConnectionWithAutoSolve(
            this.config.username,
            this.config.password,
            this.config.ip,
            undefined,
            { apiKey: this.config.twocaptcha_api_key },
          );
          await this.hvacAPI.subscribeToHVACs(this.config.macAddresses);
          // run the method to discover / register your devices as accessories
          this.discoverDevices();
        }, 30000);
      },
    );

    this.log.debug('Finished initializing platform');

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      this.log.debug('Connecting to API with auto-captcha solve...');
      await this.hvacAPI.establishConnectionWithAutoSolve(
        this.config.username,
        this.config.password,
        this.config.ip,
        undefined,
        { apiKey: this.config.twocaptcha_api_key },
      );
      await this.hvacAPI.subscribeToHVACs(this.config.macAddresses);
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
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
}
