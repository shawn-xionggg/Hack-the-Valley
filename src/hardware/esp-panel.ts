import type { Engine } from "../shared/engine-types";
import { EspAlerts } from "./esp-alerts";
import type { EspConnectionStatus, EspSerial } from "./esp-alerts";
import { EspWifiAlerts } from "./esp-wifi";

export function mountEspPanel(container: HTMLElement, engine: Engine): void {
  container.innerHTML = `
    <div class="zone-actions engine-actions esp-config">
      <label>ESP connection <select data-esp-mode><option value="wifi">Wi-Fi (wireless)</option><option value="usb">USB serial</option></select></label>
      <label data-esp-address-label>ESP address <input data-esp-address type="text" value="http://192.168.4.1" placeholder="http://192.168.4.1" spellcheck="false" /></label>
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
  const address = container.querySelector<HTMLInputElement>("[data-esp-address]")!;
  const addressLabel = container.querySelector<HTMLElement>("[data-esp-address-label]")!;
  try { address.value = localStorage.getItem("ghosttrace.esp.address") ?? address.value; }
  catch { /* A connection still works without storage. */ }
  const statuses = new Map<string, EspConnectionStatus>();
  function report(transport: string, next: EspConnectionStatus): void {
    statuses.set(transport, next);
    if (mode.value !== transport) return;
    const { phase, message } = next;
    connect.disabled = !["disconnected", "error"].includes(phase);
    disconnect.disabled = phase !== "connected";
    mode.disabled = ["connecting", "connected", "disconnecting"].includes(phase);
    address.disabled = mode.disabled;
    status.textContent = message;
  }
  const serial = (navigator as Navigator & { serial?: EspSerial }).serial;
  const usb = new EspAlerts(serial, next => report("usb", next));
  const wifi = new EspWifiAlerts(next => report("wifi", next));
  const update = (state: ReturnType<Engine["getState"]>) => { usb.update(state); wifi.update(state); };
  update(engine.getState());
  engine.subscribe(update);
  mode.addEventListener("change", () => {
    addressLabel.hidden = mode.value !== "wifi";
    report(mode.value, statuses.get(mode.value)!);
  });
  connect.addEventListener("click", () => {
    if (mode.value === "usb") { void usb.connect(); return; }
    try { localStorage.setItem("ghosttrace.esp.address", address.value); }
    catch { /* As above. */ }
    void wifi.connect(address.value);
  });
  disconnect.addEventListener("click", () => { void (mode.value === "wifi" ? wifi.disconnect() : usb.disconnect()); });
}
