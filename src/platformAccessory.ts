import {Service, PlatformAccessory, CharacteristicValue} from 'homebridge';

import {CieloHomebridgePlatform, ConnectionState} from './platform';
import {CieloHVAC} from 'node-smartcielo-ws';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class CieloPlatformAccessory {
  private service: Service;
  private temperatureDisplayUnits = 1;
  private detectedTemperatureUnit: 'F' | 'C' | null = null;

  constructor(
    private readonly platform: CieloHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly hvac: CieloHVAC,
  ) {
    // Set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Cielo')
      .setCharacteristic(this.platform.Characteristic.Model, 'BREEZ-PLUS')
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.hvac.getMacAddress(),
      );

    // Establish a Thermostat service
    this.service =
      this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    // Set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.hvac.getDeviceName(),
    );

    this.service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
      )
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [0, 1, 2, 3], // OFF, HEAT, COOL, AUTO
      })
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    const mode = this.getModeHelper(this.hvac.getPower(), this.hvac.getMode());
    this.platform.log.debug('getCurrentHeatingCoolingState', mode);
    const state = this.convertModeToHeatingCoolingState(mode);
    return state;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    const mode = this.getModeHelper(this.hvac.getPower(), this.hvac.getMode());
    this.platform.log.debug('getTargetHeatingCoolingState', mode);
    return this.convertModeToHeatingCoolingState(mode);
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    const temperature = this.hvac.getRoomTemperature();
    this.platform.log.debug('getCurrentTemperature', temperature);
    return this.convertApiTemperatureToCelsius(temperature);
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    const temperature = this.hvac.getTemperature();
    this.platform.log.debug('getTargetTemperature', temperature);
    return this.convertApiTemperatureToCelsius(temperature);
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    this.platform.log.debug(
      'getTemperatureDisplayUnits',
      this.temperatureDisplayUnits,
    );
    return this.temperatureDisplayUnits;
  }

  async setTargetHeatingCoolingState(state: CharacteristicValue) {
    const mode = this.convertHeatingCoolingStateToMode(state);
    this.platform.log.info('setTargetHeatingCoolingState called - state:', state, 'mode:', mode, 'current power:', this.hvac.getPower());

    // Pre-emptive check: if not connected, record the intent and return.
    // Fields merge, so a power-on and a mode change both survive - the old
    // queue held one action per device and silently dropped the power-on.
    if (this.platform.connectionState !== ConnectionState.CONNECTED) {
      this.platform.log.warn('Not connected - queueing command');
      if (mode === 'off') {
        this.platform.queueDesiredState(this.hvac.getMacAddress(), {power: 'off'});
      } else {
        this.platform.queueDesiredState(this.hvac.getMacAddress(), {power: 'on', mode});
      }
      return; // Return success to HomeKit - state is queued
    }

    // Try to execute, catch connection failures
    try {
      if (mode === 'off') {
        if (this.hvac.getPower() === 'off') {
          this.platform.log.info('Skipping power off command - already off');
        } else {
          this.platform.log.info('Sending power off');
          await this.hvac.powerOff(this.platform.hvacAPI);
        }
      } else {
        if (this.hvac.getPower() === 'on' && this.hvac.getMode() === mode) {
          this.platform.log.debug('Skipping Command');
        } else {
          if (this.hvac.getPower() === 'off') {
            this.platform.log.info('Sending power on');
            await this.hvac.powerOn(this.platform.hvacAPI);
            this.platform.log.debug('Sent Command', 'sendPowerOn');
            // TODO: Investigate closing the loop and removing hard-coded delay.
            // Note: Potentially there is a way to poll the power until it is updated before sending mode.
            setTimeout(async () => {
              try {
                this.platform.log.info('Setting mode to ' + mode);
                await this.hvac.setMode(mode, this.platform.hvacAPI);
              } catch (error) {
                if (this.isConnectionError(error)) {
                  this.platform.log.warn('Mode change failed due to connection loss - queueing for retry');
                  this.platform.queueDesiredState(this.hvac.getMacAddress(), {power: 'on', mode});
                  this.platform.connectionState = ConnectionState.DISCONNECTED;
                } else {
                  this.platform.log.error('Error setting mode:', error);
                }
              }
            }, 10000);
          } else {
            this.platform.log.info('Setting mode to ' + mode);
            await this.hvac.setMode(mode, this.platform.hvacAPI);
          }
        }
      }
    } catch (error) {
      // Check if it's a connection error
      if (this.isConnectionError(error)) {
        this.platform.log.warn('Command failed due to connection loss - queueing for retry');
        if (mode === 'off') {
          this.platform.queueDesiredState(this.hvac.getMacAddress(), {power: 'off'});
        } else {
          this.platform.queueDesiredState(this.hvac.getMacAddress(), {power: 'on', mode});
        }
        this.platform.connectionState = ConnectionState.DISCONNECTED;
        return; // Return success to HomeKit - state is queued
      }
      // Re-throw non-connection errors
      throw error;
    }
  }

  async setTargetTemperature(temperature: CharacteristicValue) {
    // HomeKit always sends temperature in Celsius
    // We need to convert it to whatever unit the API expects (detected earlier)
    let apiTemperature: number;

    if (this.detectedTemperatureUnit === 'C') {
      // API expects Celsius, clamp to reasonable range
      apiTemperature = Math.min(Math.max(Math.round(temperature as number), 15), 35);
      this.platform.log.debug('setTargetTemperature (Celsius mode)', apiTemperature);
    } else {
      // API expects Fahrenheit, convert and clamp
      apiTemperature = this.convertCelsiusToFahrenheit(temperature, 62, 86);
      this.platform.log.debug('setTargetTemperature (Fahrenheit mode)', apiTemperature);
    }

    if (this.hvac.getTemperature() === apiTemperature) {
      this.platform.log.debug('Skipping Command');
      return;
    }

    const displayTemp = this.detectedTemperatureUnit === 'C'
      ? `${apiTemperature} °C`
      : `${apiTemperature} °F / ${this.convertFahrenheitToCelsius(apiTemperature)} °C`;

    // Pre-emptive check: if not connected, queue immediately
    if (this.platform.connectionState !== ConnectionState.CONNECTED) {
      this.platform.log.warn('Not connected - queueing temperature command');
      this.platform.queueDesiredState(this.hvac.getMacAddress(), {
        temperature: apiTemperature.toString(),
      });
      return; // Return success to HomeKit - command is queued
    }

    // Try to execute, catch connection failures
    try {
      this.platform.log.info('Setting temperature to ' + displayTemp);
      await this.hvac.setTemperature(
        apiTemperature.toString(),
        this.platform.hvacAPI,
      );
    } catch (error) {
      // Check if it's a connection error
      if (this.isConnectionError(error)) {
        this.platform.log.warn('Temperature command failed due to connection loss - queueing for retry');
        this.platform.queueDesiredState(this.hvac.getMacAddress(), {
          temperature: apiTemperature.toString(),
        });
        this.platform.connectionState = ConnectionState.DISCONNECTED;
        return; // Return success to HomeKit - command is queued
      }
      // Re-throw non-connection errors
      throw error;
    }
  }

  async setTemperatureDisplayUnits(displayUnits: CharacteristicValue) {
    this.platform.log.debug('setTemperatureDisplayUnits', displayUnits);
    this.platform.log.info(
      'Setting temperature display units to ' + (displayUnits ? '°F' : '°C'),
    );
    this.temperatureDisplayUnits = displayUnits as number;
  }

  private getModeHelper(power, mode) {
    return power === 'off' ? 'off' : mode;
  }

  private convertCelsiusToFahrenheit(
    temperature,
    minTemperature,
    maxTemperature,
  ) {
    return Math.min(
      Math.max(Math.round((temperature * 9) / 5 + 32), minTemperature),
      maxTemperature,
    );
  }

  private convertFahrenheitToCelsius(temperature) {
    return Math.round((((temperature - 32) * 5) / 9) * 10) / 10;
  }

  /**
   * Auto-detect temperature unit from API based on temperature range
   * Fahrenheit: typically 60-95°F for HVAC operation
   * Celsius: typically 15-35°C for HVAC operation
   */
  private detectTemperatureUnit(temperature: number): 'F' | 'C' {
    // If we've already detected the unit, use that
    if (this.detectedTemperatureUnit) {
      return this.detectedTemperatureUnit;
    }

    // Heuristic: If temperature is less than 50, it's likely Celsius
    // (15-35°C is typical HVAC range, 60-95°F is typical HVAC range)
    if (temperature < 50) {
      this.platform.log.info(`Auto-detected temperature unit: Celsius (temp: ${temperature}°C)`);
      this.detectedTemperatureUnit = 'C';
      return 'C';
    } else {
      this.platform.log.info(`Auto-detected temperature unit: Fahrenheit (temp: ${temperature}°F)`);
      this.detectedTemperatureUnit = 'F';
      return 'F';
    }
  }

  /**
   * Convert API temperature to Celsius for HomeKit
   * Auto-detects if API is returning Fahrenheit or Celsius
   */
  private convertApiTemperatureToCelsius(temperature: number): number {
    const unit = this.detectTemperatureUnit(temperature);

    if (unit === 'C') {
      // API is already returning Celsius, no conversion needed
      return Math.round(temperature * 10) / 10;
    } else {
      // API is returning Fahrenheit, convert to Celsius
      return this.convertFahrenheitToCelsius(temperature);
    }
  }

  private convertHeatingCoolingStateToMode(state) {
    switch (state) {
      case 1:
        return 'heat';
      case 2:
        return 'cool';
      case 3:
        return 'auto';
      case 0:
      default:
        return 'off';
    }
  }

  private convertModeToHeatingCoolingState(mode) {
    switch (mode) {
      case 'heat':
        return 1;
      case 'cool':
        return 2;
      case 'auto':
        return 3;
      case 'off':
      default:
        return 0;
    }
  }

  /**
   * Check if an error is a connection error
   */
  private isConnectionError(error: unknown): boolean {
    if (!error) {
      return false;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for common connection error patterns
    return errorMessage.includes('Connection Closed') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('ENOTFOUND') ||
      errorMessage.includes('WebSocket') ||
      errorMessage.includes('Network');
  }
}
