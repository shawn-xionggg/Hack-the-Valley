import type { Engine } from "../shared/engine-types";
import { EspAlerts } from "./esp-alerts";
import type { EspSerial } from "./esp-alerts";

export function mountEspPanel(container: HTMLElement, engine: Engine): void {
  container.innerHTML = `
    <div class="zone-actions engine-actions">
      <button class="text-button" data-esp-connect>Connect ESP</button>
      <button class="text-button" data-esp-disconnect disabled>Disconnect ESP</button>
    </div>
    <p class="hint" data-esp-status role="status" aria-live="polite"></p>`;
  const connect = container.querySelector<HTMLButtonElement>("[data-esp-connect]")!;
  const disconnect = container.querySelector<HTMLButtonElement>("[data-esp-disconnect]")!;
  const status = container.querySelector<HTMLElement>("[data-esp-status]")!;
  const serial = (navigator as Navigator & { serial?: EspSerial }).serial;
  const esp = new EspAlerts(serial, ({ phase, message }) => {
    connect.disabled = !["disconnected", "error"].includes(phase);
    disconnect.disabled = phase !== "connected";
    status.textContent = message;
  });
  esp.update(engine.getState());
  engine.subscribe(state => esp.update(state));
  connect.addEventListener("click", () => { void esp.connect(); });
  disconnect.addEventListener("click", () => { void esp.disconnect(); });
}
