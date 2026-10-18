import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { DEMO_SCRIPT, MOVING_TONGS_SCRIPT, SCENARIOS, ScriptBuilder } from "../sim/fixtures";
import { EspAlerts, espCommand } from "./esp-alerts";
import type { EspConnectionStatus, EspSerialPort } from "./esp-alerts";

class FakePort extends EventTarget implements EspSerialPort {
  readonly lines: string[] = [];
  failWrite = false;
  holdWrite: Promise<void> | undefined;
  writable = new WritableStream<Uint8Array>({
    write: async bytes => {
      if (this.failWrite) throw new Error("USB removed");
      await this.holdWrite;
      this.lines.push(new TextDecoder().decode(bytes));
    },
  });
  open = vi.fn(async (_options: { baudRate: number }) => {});
  close = vi.fn(async () => {});
}

class FakeSerial extends EventTarget {
  port = new FakePort();
  requestPort = vi.fn(async () => this.port);
}

async function settle() {
  for (let n = 0; n < 15; n++) await Promise.resolve();
}

const bridges: EspAlerts[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.disconnect();
  vi.useRealTimers();
});

function rig() {
  const serial = new FakeSerial();
  const statuses: EspConnectionStatus[] = [];
  const bridge = new EspAlerts(serial, state => statuses.push(state));
  bridges.push(bridge);
  const engine = createEngine();
  bridge.update(engine.getState());
  engine.subscribe(state => bridge.update(state));
  return { serial, port: serial.port, statuses, bridge, engine };
}

describe("ESP output uses the existing engine verdict", () => {
  it("matches every fixture's action-required status, without mutating engine state", () => {
    for (const scenario of SCENARIOS) {
      const engine = createEngine({ orders: scenario.orders });
      for (const event of scenario.events) {
        const state = engine.dispatch(event);
        const before = structuredClone(state);
        const expected = Object.values(state.surfaces).some(s => s.status === "action-required");
        expect(espCommand(state)).toBe(expected ? "GT:ALERT\n" : "GT:IDLE\n");
        expect(state).toEqual(before);
      }
    }
  });

  it.each([DEMO_SCRIPT, MOVING_TONGS_SCRIPT])("drives $name and stays active through acknowledgement, wash and replacement", async script => {
    const { bridge, engine, port } = rig();
    await bridge.connect();
    await settle();
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200 });
    expect(port.lines).toEqual(["GT:IDLE\n"]);
    for (const event of script.events) {
      engine.dispatch(event);
      await settle();
    }
    expect(port.lines).toEqual(["GT:IDLE\n", "GT:ALERT\n"]);
    for (const event of new ScriptBuilder().wash().replace().events) {
      engine.dispatch({ ...event, id: `after-${event.id}` });
    }
    await settle();
    expect(port.lines.at(-1)).toBe("GT:ALERT\n");
    engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
    await settle();
    expect(port.lines.at(-1)).toBe("GT:IDLE\n");
  });

  it("resends current risk on connection and every second after ESP boot/reset", async () => {
    vi.useFakeTimers();
    const { bridge, engine, port } = rig();
    for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
    await bridge.connect();
    await settle();
    expect(port.lines).toEqual(["GT:ALERT\n"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(port.lines).toEqual(["GT:ALERT\n", "GT:ALERT\n", "GT:ALERT\n"]);
    await bridge.disconnect();
    expect(port.lines.at(-1)).toBe("GT:IDLE\n");
    expect(port.writable.locked).toBe(false);
    expect(port.close).toHaveBeenCalledOnce();
    const count = port.lines.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(port.lines).toHaveLength(count);
  });

  it("sends the latest state after a slow write instead of queuing stale alerts", async () => {
    const { bridge, engine, port } = rig();
    let release!: () => void;
    port.holdWrite = new Promise<void>(resolve => { release = resolve; });
    await bridge.connect();
    for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
    engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
    release();
    await settle();
    expect(port.lines).toEqual(["GT:IDLE\n", "GT:IDLE\n"]);
  });

  it("handles cancelled selection and can connect afterwards", async () => {
    const { serial, statuses, bridge } = rig();
    serial.requestPort.mockRejectedValueOnce(new DOMException("Cancelled", "NotFoundError"));
    await bridge.connect();
    expect(statuses.at(-1)?.phase).toBe("disconnected");
    await bridge.connect();
    expect(statuses.at(-1)?.phase).toBe("connected");
  });

  it("reports unplugging, releases the port, and reconnects to current risk", async () => {
    const { bridge, engine, port, statuses } = rig();
    await bridge.connect();
    await settle();
    port.dispatchEvent(new Event("disconnect"));
    await settle();
    expect(statuses.at(-1)?.phase).toBe("error");
    expect(port.writable.locked).toBe(false);
    for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
    await bridge.connect();
    await settle();
    expect(port.lines.at(-1)).toBe("GT:ALERT\n");
  });

  it("contains write failures without interrupting engine dispatch", async () => {
    vi.useFakeTimers();
    const { bridge, engine, port, statuses } = rig();
    await bridge.connect();
    await settle();
    port.failWrite = true;
    for (const event of MOVING_TONGS_SCRIPT.events) expect(() => engine.dispatch(event)).not.toThrow();
    await settle();
    expect(engine.getState().surfaces["meal-1"].status).toBe("action-required");
    expect(statuses.at(-1)?.phase).toBe("error");
    expect(port.writable.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("works without Web Serial support", async () => {
    const statuses: EspConnectionStatus[] = [];
    const bridge = new EspAlerts(undefined, status => statuses.push(status));
    await bridge.connect();
    bridge.update(createEngine().getState());
    expect(statuses.at(-1)?.phase).toBe("unsupported");
  });
});
