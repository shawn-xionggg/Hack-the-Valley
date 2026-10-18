import type { Engine } from "../shared/engine-types";
import { EspAlerts } from "./esp-alerts";
import type { EspConnectionStatus, EspSerial } from "./esp-alerts";
import { EspBluetoothAlerts } from "./esp-bluetooth";
import type { EspBluetooth } from "./esp-bluetooth";

export function mountEspPanel(container: HTMLElement, engine: Engine): void {
  container.innerHTML = `
    <div class="zone-actions engine-actions esp-config">
      <label>ESP connection <select data-esp-mode><option value="bluetooth">Bluetooth</option><option value="usb">USB serial</option></select></label>
    </div>
    <div class="zone-actions engine-actions">
      <button class="text-button" data-esp-connect>Connect ESP</button>
      <button class="text-button" data-esp-disconnect disabled>Disconnect ESP</button>
    </div>
    <p class="hint" data-esp-status role="status" aria-live="polite"></p>`;
  const connect = container.querySelector<HTMLButtonElement>("[data-esp-connect]")!;
  const disconnect = container.querySelector<HTMLButtonElement>("[data-esp-disconnect]")!;
  const status = container.querySelector<HTMLElement>("[data-esp-status]")!;
  const mode = container.querySelector<HTMLSelectElement>("[data-esp-mode]")!;
  const statuses = new Map<string, EspConnectionStatus>();
  function report(transport: string, next: EspConnectionStatus): void {
    statuses.set(transport, next);
    if (mode.value !== transport) return;
    const { phase, message } = next;
    connect.disabled = !["disconnected", "error"].includes(phase);
    disconnect.disabled = phase !== "connected";
    mode.disabled = ["connecting", "connected", "disconnecting"].includes(phase);
    status.textContent = message;
  }
  const serial = (navigator as Navigator & { serial?: EspSerial }).serial;
  const usb = new EspAlerts(serial, next => report("usb", next));
  const bluetoothApi = (navigator as Navigator & { bluetooth?: EspBluetooth }).bluetooth;
  const bluetooth = new EspBluetoothAlerts(bluetoothApi, next => report("bluetooth", next));
  const update = (state: ReturnType<Engine["getState"]>) => {
    usb.update(state); bluetooth.update(state);
  };
  update(engine.getState());
  engine.subscribe(update);
  mode.addEventListener("change", () => {
    report(mode.value, statuses.get(mode.value)!);
  });
  connect.addEventListener("click", () => {
    if (mode.value === "bluetooth") { void bluetooth.connect(); return; }
    void usb.connect();
  });
  disconnect.addEventListener("click", () => {
    void (mode.value === "bluetooth" ? bluetooth.disconnect() : usb.disconnect());
  });
}
