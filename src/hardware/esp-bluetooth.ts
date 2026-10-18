import type { EngineState } from "../shared/engine-types";
import { espCommand } from "./esp-alerts";
import type { EspConnectionStatus } from "./esp-alerts";

// These UUIDs identify GhostTrace's BLE service and command characteristic.
export const ESP_BLE_SERVICE = "b584b401-7e4b-4ec3-b6c4-781203a99270";
export const ESP_BLE_COMMAND = "b584b402-7e4b-4ec3-b6c4-781203a99270";
export const ESP_BLE_RESET = "b584b403-7e4b-4ec3-b6c4-781203a99270";

export interface EspBleCharacteristic extends EventTarget {
  readonly value?: DataView;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  startNotifications(): Promise<unknown>;
}
export interface EspBleServer {
  connected: boolean;
  connect(): Promise<EspBleServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<EspBleCharacteristic> }>;
}
export interface EspBleDevice extends EventTarget { gatt?: EspBleServer }
export interface EspBluetooth {
  requestDevice(options: { filters: { services: string[] }[] }): Promise<EspBleDevice>;
}

/** BLE transports the engine's verdict; it never dispatches an engine event. */
export class EspBluetoothAlerts {
  private phase: EspConnectionStatus["phase"];
  private device: EspBleDevice | undefined;
  private characteristic: EspBleCharacteristic | undefined;
  private resetButton: EspBleCharacteristic | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private command = "GT:IDLE\n";
  private sending = false;
  private dirty = false;
  private generation = 0;
  private disposed = false;
  private readonly encoder = new TextEncoder();
  private readonly onButton = (event: Event) => {
    if (this.phase !== "connected" || event.target !== this.resetButton) return;
    const value = this.resetButton?.value;
    if (!value || value.byteLength > 32) return;
    const text = new TextDecoder().decode(value).trim();
    // Existing button firmware emitted GT:ACK; keep it usable as a reset too.
    if (text === "GT:RESET" || text === "GT:ACK") {
      this.onReset();
    }
  };
  private readonly onDisconnected = () => {
    if (this.phase === "connecting" || this.phase === "connected") {
      this.fail(new Error("Bluetooth disconnected. Check ESP power and reconnect."));
    }
  };

  constructor(private readonly bluetooth: EspBluetooth | undefined,
    private readonly onStatus: (status: EspConnectionStatus) => void,
    private readonly onReset: () => void = () => {}) {
    this.phase = bluetooth ? "disconnected" : "unsupported";
    this.report(this.phase, bluetooth ? "ESP not connected. Connect via Bluetooth and select GhostTrace-ESP." :
      "Bluetooth unavailable. Use desktop Chrome or Edge on localhost or HTTPS with Bluetooth enabled.");
  }

  update(state: EngineState): void {
    const next = espCommand(state);
    if (next === this.command) return;
    this.command = next;
    this.send();
  }

  /** requestDevice runs directly from the Connect button's user gesture. */
  async connect(): Promise<void> {
    if (this.disposed || !this.bluetooth || ["connecting", "connected", "disconnecting"].includes(this.phase)) return;
    const generation = ++this.generation;
    this.pending = Promise.resolve();
    this.sending = false;
    this.report("connecting", "Select GhostTrace-ESP in the Bluetooth chooser...");
    try {
      const device = await this.bluetooth.requestDevice({ filters: [{ services: [ESP_BLE_SERVICE] }] });
      if (generation !== this.generation) return;
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.onDisconnected);
      if (!device.gatt) throw new Error("This device has no BLE GATT server.");
      const server = await device.gatt.connect();
      if (generation !== this.generation) return;
      const service = await server.getPrimaryService(ESP_BLE_SERVICE);
      if (generation !== this.generation) return;
      const characteristic = await service.getCharacteristic(ESP_BLE_COMMAND);
      if (generation !== this.generation) return;
      this.characteristic = characteristic;
      let resetButton: EspBleCharacteristic;
      try {
        resetButton = await service.getCharacteristic(ESP_BLE_RESET);
      } catch {
        throw new Error("Button notifications are unavailable. Upload the latest ESP32 firmware, then reconnect.");
      }
      if (generation !== this.generation) return;
      this.resetButton = resetButton;
      this.resetButton.addEventListener("characteristicvaluechanged", this.onButton);
      await this.resetButton.startNotifications();
      if (generation !== this.generation) return;
      const initial = this.command;
      await this.write(characteristic, initial);
      if (generation !== this.generation) return;
      this.report("connected", "ESP Bluetooth connected — the physical button resets the session.");
      if (this.command !== initial) this.send();
      this.heartbeat = setInterval(() => this.send(), 1000);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof DOMException && error.name === "NotFoundError" && !this.device) {
        this.clearConnection();
        this.report("disconnected", "Bluetooth connection cancelled");
      } else this.fail(error);
    }
  }

  private send(): void {
    if (this.phase !== "connected" || !this.characteristic) return;
    this.dirty = true;
    if (this.sending) return;
    this.sending = true;
    const characteristic = this.characteristic;
    const generation = this.generation;
    this.pending = (async () => {
      while (this.dirty && this.phase === "connected" && generation === this.generation) {
        this.dirty = false;
        await this.write(characteristic, this.command);
      }
    })().catch(error => {
      if (generation === this.generation && this.phase !== "disconnecting") this.fail(error);
    }).finally(() => { if (generation === this.generation) this.sending = false; });
  }

  private async write(characteristic: EspBleCharacteristic, command: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        characteristic.writeValueWithResponse(this.encoder.encode(command)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Bluetooth command timed out.")), 3000);
        }),
      ]);
    } finally { clearTimeout(timeout); }
  }

  async disconnect(): Promise<void> {
    if (this.phase !== "connected") return;
    this.report("disconnecting", "Disconnecting ESP...");
    clearInterval(this.heartbeat);
    const generation = this.generation;
    await this.pending;
    try { if (this.characteristic) await this.write(this.characteristic, "GT:IDLE\n"); }
    catch { /* Firmware indicates link loss if the ESP is no longer reachable. */ }
    if (generation !== this.generation) return;
    this.clearConnection();
    this.report("disconnected", "ESP not connected");
  }

  private clearConnection(): void {
    ++this.generation;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.resetButton?.removeEventListener("characteristicvaluechanged", this.onButton);
    this.resetButton = undefined;
    this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected);
    this.device?.gatt?.disconnect();
    this.device = undefined;
    this.characteristic = undefined;
    this.sending = false;
    this.dirty = false;
  }

  /** Release resources when a dashboard panel unmounts, including during setup. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearConnection();
    this.phase = "disconnected";
  }

  private fail(error: unknown): void {
    this.clearConnection();
    this.report("error", `ESP Bluetooth failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  private report(phase: EspConnectionStatus["phase"], message: string): void {
    this.phase = phase;
    this.onStatus({ phase, message });
  }
}
