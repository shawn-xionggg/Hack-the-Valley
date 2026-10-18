import { afterEach, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { MOVING_TONGS_SCRIPT } from "../sim/fixtures";
import { ESP_BLE_COMMAND, ESP_BLE_SERVICE, EspBluetoothAlerts } from "./esp-bluetooth";
import type { EspBleDevice, EspBleServer, EspBluetooth } from "./esp-bluetooth";
import type { EspConnectionStatus } from "./esp-alerts";

class FakeDevice extends EventTarget implements EspBleDevice {
  lines: string[] = [];
  write = vi.fn(async (value: Uint8Array) => { this.lines.push(new TextDecoder().decode(value)); });
  getCharacteristic = vi.fn(async (_uuid: string) => ({ writeValueWithResponse: this.write }));
  gatt: EspBleServer = {
    connected: false,
    connect: vi.fn(async () => { this.gatt.connected = true; return this.gatt; }),
    disconnect: vi.fn(() => {
      this.gatt.connected = false;
      this.dispatchEvent(new Event("gattserverdisconnected"));
    }),
    getPrimaryService: vi.fn(async (_uuid: string) => ({ getCharacteristic: this.getCharacteristic })),
  };
}

const bridges: EspBluetoothAlerts[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.disconnect();
  vi.useRealTimers();
});
async function settle() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

function rig() {
  const device = new FakeDevice();
  const requestDevice = vi.fn<EspBluetooth["requestDevice"]>(async () => device);
  const statuses: EspConnectionStatus[] = [];
  const ble = new EspBluetoothAlerts({ requestDevice }, status => statuses.push(status));
  bridges.push(ble);
  const engine = createEngine();
  ble.update(engine.getState());
  engine.subscribe(state => ble.update(state));
  return { ble, device, requestDevice, statuses, engine };
}

it("selects the GhostTrace BLE service and sends the existing risk verdict", async () => {
  const { ble, device, engine, requestDevice, statuses } = rig();
  await ble.connect();
  expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: [ESP_BLE_SERVICE] }] });
  expect(device.gatt.getPrimaryService).toHaveBeenCalledWith(ESP_BLE_SERVICE);
  expect(device.getCharacteristic).toHaveBeenCalledWith(ESP_BLE_COMMAND);
  expect(statuses.at(-1)?.phase).toBe("connected");
  expect(device.lines).toEqual(["GT:IDLE\n"]);
  for (const event of MOVING_TONGS_SCRIPT.events) {
    engine.dispatch(event);
    await settle();
  }
  // The script includes acknowledgement; the alert and hardware output remain active.
  expect(device.lines).toEqual(["GT:IDLE\n", "GT:ALERT\n"]);
  engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
  await settle();
  expect(device.lines.at(-1)).toBe("GT:IDLE\n");
});

it("sends an existing alert on connection, repeats it, and sends idle before disconnect", async () => {
  vi.useFakeTimers();
  const { ble, device, engine, statuses } = rig();
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  await ble.connect();
  await vi.advanceTimersByTimeAsync(2000);
  expect(device.lines).toEqual(["GT:ALERT\n", "GT:ALERT\n", "GT:ALERT\n"]);
  await ble.disconnect();
  expect(device.lines.at(-1)).toBe("GT:IDLE\n");
  expect(device.gatt.connected).toBe(false);
  expect(statuses.at(-1)?.phase).toBe("disconnected");
  expect(vi.getTimerCount()).toBe(0);
});

it("sends a changed verdict after a slow connection write finishes", async () => {
  const { ble, device, engine } = rig();
  let release!: () => void;
  device.write.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const connecting = ble.connect();
  await settle();
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  release();
  await connecting;
  await settle();
  expect(device.lines).toEqual(["GT:ALERT\n"]);
});

it("coalesces slow BLE writes and sends the latest verdict", async () => {
  const { ble, device, engine } = rig();
  await ble.connect();
  let release!: () => void;
  device.write.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
  release();
  await settle();
  expect(device.lines).toEqual(["GT:IDLE\n", "GT:IDLE\n"]);
});

it("handles chooser cancellation and can connect afterwards", async () => {
  const { ble, requestDevice, statuses } = rig();
  requestDevice.mockRejectedValueOnce(new DOMException("Cancelled", "NotFoundError"));
  await ble.connect();
  expect(statuses.at(-1)?.phase).toBe("disconnected");
  await ble.connect();
  expect(statuses.at(-1)?.phase).toBe("connected");
});

it("reports a missing service as an error and releases Bluetooth", async () => {
  const { ble, device, statuses } = rig();
  vi.mocked(device.gatt.getPrimaryService).mockRejectedValueOnce(new DOMException("Service missing", "NotFoundError"));
  await ble.connect();
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(device.gatt.connected).toBe(false);
});

it("reports BLE disconnection, stops heartbeats, and reconnects with the current risk", async () => {
  vi.useFakeTimers();
  const { ble, device, statuses, engine } = rig();
  await ble.connect();
  device.gatt.disconnect();
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(vi.getTimerCount()).toBe(0);
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  await ble.connect();
  expect(device.lines.at(-1)).toBe("GT:ALERT\n");
  expect(statuses.at(-1)?.phase).toBe("connected");
});

it("contains write failures without interrupting engine dispatch", async () => {
  const { ble, device, engine, statuses } = rig();
  await ble.connect();
  device.write.mockRejectedValueOnce(new Error("GATT write failed"));
  for (const event of MOVING_TONGS_SCRIPT.events) expect(() => engine.dispatch(event)).not.toThrow();
  await settle();
  expect(engine.getState().surfaces["meal-1"].status).toBe("action-required");
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(device.gatt.connected).toBe(false);
});

it("disconnects after a stalled BLE write times out", async () => {
  vi.useFakeTimers();
  const { ble, device, statuses } = rig();
  device.write.mockImplementationOnce(() => new Promise(() => {}));
  const connecting = ble.connect();
  await settle();
  await vi.advanceTimersByTimeAsync(3000);
  await connecting;
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(device.gatt.connected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores failures from an old connection after reconnecting", async () => {
  const { ble, device, statuses, engine } = rig();
  await ble.connect();
  let rejectOld!: (reason: Error) => void;
  device.write.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  device.gatt.disconnect();
  await ble.connect();
  rejectOld(new Error("Old connection failed"));
  await settle();
  expect(statuses.at(-1)?.phase).toBe("connected");
  expect(device.gatt.connected).toBe(true);
});

it("handles browsers without Web Bluetooth", async () => {
  const statuses: EspConnectionStatus[] = [];
  const ble = new EspBluetoothAlerts(undefined, status => statuses.push(status));
  await ble.connect();
  ble.update(createEngine().getState());
  expect(statuses.at(-1)?.phase).toBe("unsupported");
});
