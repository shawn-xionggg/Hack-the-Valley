// GhostTrace vision module API — what Person 1 implements and Person 2 wires up.
// Spec: GhostTrace-summary-v4.md ("Module contracts").

import type { Tuning, ZoneLayout } from "./config";
import type { ContactEvent, VisionStatus, WashEvent } from "./events";

export interface VisionOptions {
  /** A playing <video> element showing the RAW (unmirrored) camera stream. */
  video: HTMLVideoElement;
  /** Calibrated zones in normalized raw-frame coordinates. */
  zones: ZoneLayout;
  tuning?: Partial<Tuning>;
  /** Called once per detected touch or wash. The only events vision ever emits. */
  onEvent: (event: ContactEvent | WashEvent) => void;
  /** Called every processed frame (or throttled) for the debug panel and wash progress ring. */
  onStatus?: (status: VisionStatus) => void;
}

export interface VisionHandle {
  stop(): void;
  /** Swap zones after recalibration without restarting the camera. */
  setZones(zones: ZoneLayout): void;
}

export type StartVision = (options: VisionOptions) => Promise<VisionHandle>;
