import { afterEach, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { MOVING_TONGS_SCRIPT } from "../sim/fixtures";
import { ESP_BLE_RESET, ESP_BLE_COMMAND, ESP_BLE_SERVICE, EspBluetoothAlerts } from "./esp-bluetooth";
import type { EspBleDevice, EspBleServer, EspBluetooth } from "./esp-bluetooth";
import type { EspConnectionStatus } from "./esp-alerts";
import { handleEspButton } from "./esp-button";

class FakeCharacteristic extends EventTarget {
  value?: DataView;
  constructor(private readonly onWrite: (value: Uint8Array) => void = () => {}) { super(); }
  writeValueWithResponse = vi.fn(async (value: Uint8Array) => { this.onWrite(value); });
  startNotifications = vi.fn(async () => {});
  notify(text: string) {
    const bytes = new TextEncoder().encode(text);
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class FakeDevice extends EventTarget implements EspBleDevice {
  lines: string[] = [];
  commandCharacteristic = new FakeCharacteristic(value => { this.lines.push(new TextDecoder().decode(value)); });
  resetButton = new FakeCharacteristic();
  write = this.commandCharacteristic.writeValueWithResponse;
  getCharacteristic = vi.fn(async (uuid: string) => {
    if (uuid === ESP_BLE_COMMAND) return this.commandCharacteristic;
    if (uuid === ESP_BLE_RESET) return this.resetButton;
    throw new Error("Unknown characteristic");
  });
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
  const engine = createEngine();
  const onReset = vi.fn(() => handleEspButton(engine));
  const ble = new EspBluetoothAlerts({ requestDevice }, status => statuses.push(status),
    onReset);
  bridges.push(ble);
  ble.update(engine.getState());
  engine.subscribe(state => ble.update(state));
  return { ble, device, requestDevice, statuses, engine, onReset };
}

it("selects the Allos BLE service and sends the existing risk verdict", async () => {
  const { ble, device, engine, requestDevice, statuses } = rig();
  await ble.connect();
  expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: [ESP_BLE_SERVICE] }] });
  expect(device.gatt.getPrimaryService).toHaveBeenCalledWith(ESP_BLE_SERVICE);
  expect(device.getCharacteristic).toHaveBeenCalledWith(ESP_BLE_COMMAND);
  expect(device.getCharacteristic).toHaveBeenCalledWith(ESP_BLE_RESET);
  expect(device.resetButton.startNotifications).toHaveBeenCalledOnce();
  expect(statuses.at(-1)?.phase).toBe("connected");
  expect(device.lines).toEqual(["GT:IDLE\n"]);
  for (const event of MOVING_TONGS_SCRIPT.events) {
    engine.dispatch(event);
    await settle();
  }
  // Scripted on-screen acknowledgement silences the buzzer while the meal stays on hold.
  expect(device.lines).toEqual(["GT:IDLE\n", "GT:ALERT\n", "GT:ACKED\n"]);
  expect(engine.getState().surfaces["meal-1"].status).toBe("action-required");
  engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
  await settle();
  expect(device.lines.at(-1)).toBe("GT:IDLE\n");
});

it("sends an existing alert on connection, repeats it, and sends idle before disconnect", async () => {
  vi.useFakeTimers();
  const { ble, device, engine, statuses } = rig();
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
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
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
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
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
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
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
  await ble.connect();
  expect(device.lines.at(-1)).toBe("GT:ALERT\n");
  expect(statuses.at(-1)?.phase).toBe("connected");
});

it("contains write failures without interrupting engine dispatch", async () => {
  const { ble, device, engine, statuses } = rig();
  await ble.connect();
  device.write.mockRejectedValueOnce(new Error("GATT write failed"));
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) expect(() => engine.dispatch(event)).not.toThrow();
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
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
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

it("acknowledges on the first press and resets only the meal on the second press", async () => {
  const { ble, device, engine, onReset } = rig();
  await ble.connect();
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
  await settle();
  const before = engine.getState();
  expect(engine.getState().alerts[0]?.acknowledged).toBe(false);
  device.resetButton.notify("GT:RESET\n");
  const acknowledged = engine.getState();
  expect(onReset).toHaveBeenCalledOnce();
  expect(acknowledged.alerts[0]?.acknowledged).toBe(true);
  expect(acknowledged.surfaces).toEqual(before.surfaces);
  expect(acknowledged.records).toEqual(before.records);
  await settle();
  expect(device.lines.at(-1)).toBe("GT:ACKED\n");
  device.resetButton.notify("GT:RESET\n");
  const after = engine.getState();
  expect(after.sessionId).toBe(before.sessionId);
  expect(after.alerts).toEqual([]);
  expect(after.log.slice(0, before.log.length)).toEqual(before.log);
  expect(after.log).toHaveLength(before.log.length + 2);
  expect(after.log.at(-1)?.event).toMatchObject({ kind: "meal-reset", mealId: "meal-1", source: "manual" });
  expect(after.surfaces["meal-1"].status).toBe("no-tracked-exposure");
  for (const id of ["hands", "tongs-tip", "tongs-handle", "peanut-source"] as const) {
    expect(after.surfaces[id]).toEqual(before.surfaces[id]);
  }
  expect(after.records.filter(record => record.surfaceId !== "meal-1"))
    .toEqual(before.records.filter(record => record.surfaceId !== "meal-1"));
  expect(after.lastWash).toEqual(before.lastWash);
  expect(after.lastUtensilWash).toEqual(before.lastUtensilWash);
  await settle();
  expect(device.lines.at(-1)).toBe("GT:IDLE\n");
  const oldAlertId = before.alerts[0]!.id;
  engine.dispatch({ kind: "contact", a: "tongs-tip", b: "meal-1", confidence: 1,
    id: "new-meal-contact", t: 15000, source: "camera" });
  await settle();
  expect(device.lines.at(-1)).toBe("GT:ALERT\n");
  expect(engine.getState().alerts[0]?.acknowledged).toBe(false);
  expect(engine.getState().alerts[0]?.id).not.toBe(oldAlertId);
  engine.dispatch({ kind: "alert-acknowledged", alertId: oldAlertId,
    id: "stale-ack", t: 16000, source: "manual" });
  expect(engine.getState().alerts[0]?.acknowledged).toBe(false);
});

it("keeps acknowledged alerts silent across heartbeats/reconnect and re-arms for a new session alert", async () => {
  vi.useFakeTimers();
  const { ble, device, engine } = rig();
  await ble.connect();
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
  await settle();
  engine.dispatch({ kind: "alert-acknowledged", alertId: engine.getState().alerts[0]!.id,
    id: "screen-ack", t: 5000, source: "manual" });
  await settle();
  await vi.advanceTimersByTimeAsync(2000);
  expect(device.lines.slice(-3)).toEqual(["GT:ACKED\n", "GT:ACKED\n", "GT:ACKED\n"]);
  engine.dispatch({ kind: "wash", id: "post-ack-wash", t: 8000, source: "manual", method: "manual-tap", verified: false });
  expect(engine.getState().surfaces["meal-1"].status).toBe("action-required");
  device.gatt.disconnect();
  await ble.connect();
  expect(device.lines.at(-1)).toBe("GT:ACKED\n");
  engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
  await settle();
  expect(device.lines.at(-1)).toBe("GT:ALERT\n");
  expect(engine.getState().alerts[0]?.acknowledged).toBe(false);
});

it("does nothing without a meal alert and accepts legacy button notifications", async () => {
  const { ble, device, engine, onReset } = rig();
  await ble.connect();
  for (const event of MOVING_TONGS_SCRIPT.events.slice(0, 2)) engine.dispatch(event);
  expect(engine.getState().alerts).toHaveLength(0);
  expect(engine.getState().surfaces["tongs-tip"].status).toBe("potential-exposure");
  const before = engine.getState();
  device.resetButton.notify("GT:RESET\n");
  expect(engine.getState()).toBe(before);
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  expect(engine.getState().alerts[0]?.acknowledged).toBe(true);
  // Previous firmware's GT:ACK notification uses the same two-step action.
  device.resetButton.notify("GT:ACK\n");
  expect(engine.getState().alerts).toHaveLength(0);
  expect(engine.getState().surfaces["meal-1"].status).toBe("no-tracked-exposure");
  expect(engine.getState().surfaces["tongs-tip"].status).toBe("potential-exposure");
  expect(onReset).toHaveBeenCalledTimes(2);
});

it("ignores malformed or disconnected button notifications", async () => {
  const { ble, device, engine } = rig();
  await ble.connect();
  for (const event of MOVING_TONGS_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged")) engine.dispatch(event);
  await settle();
  device.resetButton.notify("GT:INVALID\n");
  device.resetButton.notify("x".repeat(64));
  expect(engine.getState().alerts[0]?.acknowledged).toBe(false);
  device.gatt.disconnect();
  device.resetButton.notify("GT:ACK\n");
  expect(engine.getState().alerts[0]?.acknowledged).toBe(false);
});

it("reports outdated firmware and notification subscription failures", async () => {
  const { ble, device, statuses } = rig();
  device.getCharacteristic.mockImplementationOnce(async () => device.commandCharacteristic)
    .mockRejectedValueOnce(new Error("Characteristic missing"));
  await ble.connect();
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(statuses.at(-1)?.message).toContain("Upload the latest ESP32 firmware");
  device.resetButton.startNotifications.mockRejectedValueOnce(new Error("Subscription failed"));
  await ble.connect();
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(device.gatt.connected).toBe(false);
});

it("releases Bluetooth and stops button notifications/heartbeats when a dashboard panel unmounts", async () => {
  vi.useFakeTimers();
  const { ble, device, requestDevice, onReset } = rig();
  await ble.connect();
  const count = device.lines.length;
  ble.dispose();
  device.resetButton.notify("GT:RESET\n");
  await vi.advanceTimersByTimeAsync(3000);
  expect(onReset).not.toHaveBeenCalled();
  expect(device.gatt.connected).toBe(false);
  expect(device.lines).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
  await ble.connect();
  expect(requestDevice).toHaveBeenCalledOnce();
});

it("does not open a late Bluetooth selection after the panel was removed", async () => {
  const { ble, device, requestDevice } = rig();
  let select!: (device: EspBleDevice) => void;
  requestDevice.mockImplementationOnce(() => new Promise(resolve => { select = resolve; }));
  const connecting = ble.connect();
  ble.dispose();
  select(device);
  await connecting;
  expect(device.gatt.connect).not.toHaveBeenCalled();
  expect(device.lines).toEqual([]);
});
