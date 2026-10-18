import { useEffect, useRef } from "react";
import type { Engine } from "../../shared/engine-types";
import { mountEspPanel } from "../../hardware/esp-panel";

export function EspConnectionPanel({ engine, onReset }: { engine: Engine; onReset: () => void }) {
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (controls.current) return mountEspPanel(controls.current, engine, onReset);
  }, [engine, onReset]);

  return (
    <section className="panel esp-panel" aria-label="ESP connection">
      <h2>ESP connection</h2>
      <div ref={controls} />
    </section>
  );
}
