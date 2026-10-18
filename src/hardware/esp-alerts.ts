import type { EngineState } from "../shared/engine-types";

// Local structural types keep Web Serial optional without adding a dependency or
// changing the shared engine/vision contracts.
export interface EspSerialPort extends EventTarget {
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export interface EspSerial extends EventTarget {
  requestPort(): Promise<EspSerialPort>;
}

type Phase = "unsupported" | "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
export interface EspConnectionStatus { phase: Phase; message: string }

/** Read the engine's existing verdict. Never dispatches events or evaluates contacts. */
export function espCommand(state: EngineState): string {
  return Object.values(state.surfaces).some(surface => surface.status === "action-required")
    ? "GT:ALERT\n" : "GT:IDLE\n";
}

export class EspAlerts {
  private port: EspSerialPort | undefined;
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private command = "GT:IDLE\n";
  private sending = false;
  private dirty = false;
  private phase: Phase;
  private readonly encoder = new TextEncoder();
  private readonly onUnplug = (event: Event) => {
    if (event.target === this.port || (event as Event & { port?: EspSerialPort }).port === this.port) {
      void this.disconnect(false, "ESP disconnected. Reconnect its USB cable and select Connect ESP.");
    }
  };

  constructor(private readonly serial: EspSerial | undefined,
    private readonly onStatus: (status: EspConnectionStatus) => void) {
    this.phase = serial ? "disconnected" : "unsupported";
    this.report(this.phase, serial ? "ESP not connected" : "USB serial unavailable. Use desktop Chrome or Edge on localhost or HTTPS.");
  }

  update(state: EngineState): void {
    const next = espCommand(state);
    if (next === this.command) return;
    this.command = next;
    this.send();
  }

  /** Call directly from a click: requestPort requires a browser user gesture. */
  async connect(): Promise<void> {
    if (!this.serial || ["connecting", "connected", "disconnecting"].includes(this.phase)) return;
    this.report("connecting", "Select the ESP USB serial port...");
    let opened = false;
    try {
      this.port = await this.serial.requestPort();
      await this.port.open({ baudRate: 115200 });
      opened = true;
      if (!this.port.writable) throw new Error("Serial port is not writable.");
      this.writer = this.port.writable.getWriter();
      this.port.addEventListener("disconnect", this.onUnplug);
      this.serial.addEventListener("disconnect", this.onUnplug);
      this.report("connected", "ESP USB connected — lights and buzzer follow Action required.");
      this.send();
      // Re-send after USB auto-reset/boot and keep the firmware's link timer alive.
      this.heartbeat = setInterval(() => this.send(), 1000);
    } catch (error) {
      if (opened) await this.port?.close().catch(() => {});
      this.port = undefined;
      const cancelled = error instanceof DOMException && error.name === "NotFoundError";
      this.report(cancelled ? "disconnected" : "error", cancelled ? "ESP connection cancelled" :
        `ESP connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Coalesce slow writes so repeated camera events cannot build an output backlog. */
  private send(): void {
    if (this.phase !== "connected" || !this.writer) return;
    this.dirty = true;
    if (this.sending) return;
    this.sending = true;
    const writer = this.writer;
    this.pending = (async () => {
      while (this.dirty && this.phase === "connected") {
        this.dirty = false;
        await writer.write(this.encoder.encode(this.command));
      }
    })().catch(() => {
      void this.disconnect(false, "ESP serial write failed. Check USB and reconnect.");
    }).finally(() => { this.sending = false; });
  }

  async disconnect(sendIdle = true, error?: string): Promise<void> {
    if (this.phase !== "connected") return;
    this.report("disconnecting", "Disconnecting ESP...");
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const port = this.port;
    const writer = this.writer;
    port?.removeEventListener("disconnect", this.onUnplug);
    this.serial?.removeEventListener("disconnect", this.onUnplug);
    await this.pending;
    try {
      if (sendIdle) await writer?.write(this.encoder.encode("GT:IDLE\n"));
    } catch { /* An unplugged ESP is already unreachable. */ }
    writer?.releaseLock();
    await port?.close().catch(() => {});
    this.writer = undefined;
    this.port = undefined;
    this.report(error ? "error" : "disconnected", error ?? "ESP not connected");
  }

  private report(phase: Phase, message: string): void {
    this.phase = phase;
    this.onStatus({ phase, message });
  }
}
