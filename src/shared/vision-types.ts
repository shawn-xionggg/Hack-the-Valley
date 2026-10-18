// Allos vision module API — what Person 1 implements and Person 2 wires up.
// Spec: Allos-summary-v5.md ("Module contracts").

import type { Tuning, UtensilModels, ZoneLayout } from "./config";
import type { ContactEvent, UtensilWashedEvent, VisionStatus, WashEvent } from "./events";

export interface VisionOptions {
  /** A playing <video> element showing the RAW (unmirrored) camera stream. */
  video: HTMLVideoElement;
  /** Calibrated zones in normalized raw-frame coordinates. */
  zones: ZoneLayout;
  tuning?: Partial<Tuning>;
  /** Marker-relative utensil models. A utensil without one uses the fixed ZoneLayout polygons (tracking "fixed"). */
  utensilModels?: UtensilModels;
  /** Called once per detected touch, wash or utensil wash (A3: always right after its wash). The only events vision ever emits. */
  onEvent: (event: ContactEvent | WashEvent | UtensilWashedEvent) => void;
  /** Called every processed frame (or throttled) for the debug panel and wash progress ring. */
  onStatus?: (status: VisionStatus) => void;
}

export interface VisionHandle {
  stop(): void;
  /** Swap zones after recalibration without restarting the camera. */
  setZones(zones: ZoneLayout): void;
  /** Swap utensil models after recalibration without restarting the camera. */
  setUtensilModels(models: UtensilModels): void;
}

export type StartVision = (options: VisionOptions) => Promise<VisionHandle>;
