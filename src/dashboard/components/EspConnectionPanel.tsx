import { useEffect, useRef } from "react";
import type { Engine } from "../../shared/engine-types";
import { mountEspPanel } from "../../hardware/esp-panel";

export function EspConnectionPanel({ engine }: { engine: Engine }) {
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (controls.current) return mountEspPanel(controls.current, engine);
  }, [engine]);

  return (
    <section className="panel esp-panel" aria-label="ESP connection">
      <h2>ESP connection</h2>
      <div ref={controls} />
    </section>
  );
}
