import type { EngineState } from "../shared/engine-types";
import { espCommand } from "./esp-alerts";
import type { EspConnectionStatus } from "./esp-alerts";

/** HTTP transport only; the existing engine remains the source of the verdict. */
export class EspWifiAlerts {
  private phase: EspConnectionStatus["phase"] = "disconnected";
  private endpoint = "";
  private command = "GT:IDLE\n";
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private sending = false;
  private dirty = false;

  constructor(private readonly onStatus: (status: EspConnectionStatus) => void,
    private readonly request: typeof fetch = fetch) {
    this.report("disconnected", "ESP not connected. Join GhostTrace-ESP Wi-Fi, then connect.");
  }

  update(state: EngineState): void {
    const next = espCommand(state);
    if (next === this.command) return;
    this.command = next;
    this.send();
  }

  async connect(address: string): Promise<void> {
    if (["connecting", "connected", "disconnecting"].includes(this.phase)) return;
    this.report("connecting", "Connecting to ESP over Wi-Fi...");
    try {
      const url = new URL(address.includes("://") ? address.trim() : `http://${address.trim()}`);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Enter the ESP IP address or origin, such as http://192.168.4.1.");
      }
      this.endpoint = `${url.origin}/alert`;
      const initial = this.command;
      await this.post(initial);
      this.report("connected", "ESP Wi-Fi connected — lights and buzzer follow Action required.");
      // A verdict may change while the first request is in flight.
      if (this.command !== initial) this.send();
      this.heartbeat = setInterval(() => this.send(), 1000);
    } catch (error) {
      this.fail(error);
    }
  }

  private send(): void {
    if (this.phase !== "connected") return;
    this.dirty = true;
    if (this.sending) return;
    this.sending = true;
    this.pending = (async () => {
      while (this.dirty && this.phase === "connected") {
        this.dirty = false;
        await this.post(this.command);
      }
    })().catch(error => {
      if (this.phase !== "disconnecting") this.fail(error);
    }).finally(() => { this.sending = false; });
  }

  private async post(command: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await this.request(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: command,
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`ESP returned HTTP ${response.status}.`);
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("device" in data) ||
        data.device !== "ghosttrace-esp32" || !("command" in data) || data.command !== command.trim()) {
        throw new Error("Unexpected ESP response. Upload the Wi-Fi firmware and check its address.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async disconnect(): Promise<void> {
    if (this.phase !== "connected") return;
    this.report("disconnecting", "Disconnecting ESP...");
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    await this.pending;
    try { await this.post("GT:IDLE\n"); }
    catch { /* Firmware indicates link loss if the board is unreachable. */ }
    this.report("disconnected", "ESP not connected");
  }

  private fail(error: unknown): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.report("error", `ESP Wi-Fi failed: ${error instanceof Error ? error.message : String(error)} ` +
      "Check power, Wi-Fi, address and browser local-network permission; then reconnect.");
  }

  private report(phase: EspConnectionStatus["phase"], message: string): void {
    this.phase = phase;
    this.onStatus({ phase, message });
  }
}
