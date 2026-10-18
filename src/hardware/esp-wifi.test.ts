import { afterEach, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { MOVING_TONGS_SCRIPT } from "../sim/fixtures";
import { EspWifiAlerts } from "./esp-wifi";
import type { EspConnectionStatus } from "./esp-alerts";

const bridges: EspWifiAlerts[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.disconnect();
  vi.useRealTimers();
});

async function settle() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

function rig() {
  const statuses: EspConnectionStatus[] = [];
  const request = vi.fn<typeof fetch>(async (_input, init) => new Response(JSON.stringify({
    device: "ghosttrace-esp32", command: String(init?.body).trim(),
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const wifi = new EspWifiAlerts(status => statuses.push(status), request);
  bridges.push(wifi);
  const engine = createEngine();
  wifi.update(engine.getState());
  engine.subscribe(state => wifi.update(state));
  const bodies = () => request.mock.calls.map(([, init]) => init?.body);
  return { wifi, engine, request, statuses, bodies };
}

it("sends existing risk over Wi-Fi, retains it after acknowledgement, and clears on reset", async () => {
  const { wifi, engine, statuses, request, bodies } = rig();
  await wifi.connect("192.168.4.1");
  expect(statuses.at(-1)?.phase).toBe("connected");
  expect(request.mock.calls[0]?.[0]).toBe("http://192.168.4.1/alert");
  for (const event of MOVING_TONGS_SCRIPT.events) {
    engine.dispatch(event);
    await settle();
  }
  expect(bodies()).toEqual(["GT:IDLE\n", "GT:ALERT\n"]);
  engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
  await settle();
  expect(bodies().at(-1)).toBe("GT:IDLE\n");
});

it("connects to an already active alert and keeps the firmware heartbeat alive", async () => {
  vi.useFakeTimers();
  const { wifi, engine, bodies } = rig();
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  await wifi.connect("http://192.168.4.1");
  expect(bodies()).toEqual(["GT:ALERT\n"]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(bodies()).toEqual(["GT:ALERT\n", "GT:ALERT\n", "GT:ALERT\n"]);
  await wifi.disconnect();
  expect(bodies().at(-1)).toBe("GT:IDLE\n");
  const count = bodies().length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(bodies()).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

it("sends a changed verdict when the initial connection request finishes", async () => {
  const { wifi, request, engine, bodies } = rig();
  let release!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const connecting = wifi.connect("192.168.4.1");
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  release(new Response(JSON.stringify({ device: "ghosttrace-esp32", command: "GT:IDLE" })));
  await connecting;
  await settle();
  expect(bodies()).toEqual(["GT:IDLE\n", "GT:ALERT\n"]);
});

it("coalesces slow requests and sends the latest verdict instead of stale queued alerts", async () => {
  const { wifi, request, engine, bodies } = rig();
  await wifi.connect("192.168.4.1");
  let release!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  engine.dispatch({ kind: "session-reset", id: "reset", t: 10000, source: "manual" });
  release(new Response(JSON.stringify({ device: "ghosttrace-esp32", command: "GT:ALERT" })));
  await settle();
  expect(bodies()).toEqual(["GT:IDLE\n", "GT:ALERT\n", "GT:IDLE\n"]);
});

it.each(["ftp://192.168.4.1", "http://user:password@192.168.4.1", "http://192.168.4.1/wrong", ""])(
  "rejects invalid ESP address %s without making a request", async address => {
    const { wifi, statuses, request } = rig();
    await wifi.connect(address);
    expect(statuses.at(-1)?.phase).toBe("error");
    expect(request).not.toHaveBeenCalled();
  });

it.each([
  () => new Response("error", { status: 500 }),
  () => new Response(JSON.stringify({ device: "other-device", command: "GT:IDLE" })),
  () => new Response(JSON.stringify({ device: "ghosttrace-esp32", command: "GT:ALERT" })),
  () => new Response("not json"),
])("rejects HTTP failures or invalid acknowledgements", async response => {
  const { wifi, statuses, request } = rig();
  request.mockResolvedValueOnce(response());
  await wifi.connect("192.168.4.1");
  expect(statuses.at(-1)?.phase).toBe("error");
});

it("reports Wi-Fi loss without changing engine state and resends current risk on reconnect", async () => {
  vi.useFakeTimers();
  const { wifi, engine, request, statuses, bodies } = rig();
  await wifi.connect("192.168.4.1");
  request.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  for (const event of MOVING_TONGS_SCRIPT.events) engine.dispatch(event);
  await settle();
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(vi.getTimerCount()).toBe(0);
  expect(engine.getState().surfaces["meal-1"].status).toBe("action-required");
  await wifi.connect("192.168.4.1");
  expect(bodies().at(-1)).toBe("GT:ALERT\n");
  expect(statuses.at(-1)?.phase).toBe("connected");
});

it("aborts a stalled Wi-Fi request after two seconds", async () => {
  vi.useFakeTimers();
  const { wifi, request, statuses } = rig();
  request.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
  }));
  const connecting = wifi.connect("192.168.4.1");
  await vi.advanceTimersByTimeAsync(2000);
  await connecting;
  expect(statuses.at(-1)?.phase).toBe("error");
  expect(vi.getTimerCount()).toBe(0);
});
