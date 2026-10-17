// GhostTrace shared event schema — the ONLY way anything changes engine state.
// Engine state is a pure function of the ordered event log: replaying the same
// events always produces the same state. Spec: GhostTrace-summary-v4.md.

import type { ContactTarget, UtensilId } from "./config";

export type EventSource = "camera" | "manual" | "sim";
export type WashMethod = "zone-dwell" | "motion" | "manual-tap" | "manual-voice";

interface EventBase {
  /** Unique per event. Use crypto.randomUUID(); the engine ignores repeated ids. */
  id: string;
  /** Milliseconds from performance.now() in this browser tab (one monotonic clock). */
  t: number;
}

/** A fingertip dwelled in a surface's zone. Fired ONCE per touch (enter → dwell → fire; must exit before the next). */
export interface ContactEvent extends EventBase {
  kind: "contact";
  a: "hands";
  b: ContactTarget; // "tongs-tip" or "tongs-handle", never "tongs"
  /** Fraction (0–1) of dwell-window frames where a fingertip was inside the zone. NOT a probability of physical contact. */
  confidence: number;
  source: "camera" | "sim";
}

/** Hands were washed. Clears tracked exposure on "hands" ONLY. Never certifies cleanliness. */
export interface WashEvent extends EventBase {
  kind: "wash";
  method: WashMethod;
  durationMs?: number; // time in the wash zone, for camera-detected washes
  source: EventSource; // "camera" for zone-dwell/motion; "manual" for tap/voice; "sim" in simulation
  verified: false; // always false
}

/** A person confirmed the utensil was replaced. Resets ALL surfaces of that utensil (tip and handle). */
export interface UtensilReplacedEvent extends EventBase {
  kind: "utensil-replaced-confirmed";
  utensilId: UtensilId;
  source: "manual" | "sim";
}

/** A person acknowledged an alert. Does NOT clear any exposure; the meal stays "action-required". */
export interface AlertAcknowledgedEvent extends EventBase {
  kind: "alert-acknowledged";
  alertId: string;
  source: "manual" | "sim";
}

/** Start a fresh demo run: clears all state, alerts, and history; starts a new session. */
export interface SessionResetEvent extends EventBase {
  kind: "session-reset";
  source: "manual" | "sim";
}

export type GhostEvent =
  | ContactEvent
  | WashEvent
  | UtensilReplacedEvent
  | AlertAcknowledgedEvent
  | SessionResetEvent;

export type GhostEventKind = GhostEvent["kind"];

/**
 * Live status from the vision module for the dashboard (progress ring, debug panel).
 * This is NOT an engine event and never changes exposure state.
 */
export interface VisionStatus {
  t: number;
  handsVisible: number; // 0, 1 or 2 hands detected this frame
  activeZones: ContactTarget[]; // zones a fingertip is currently inside
  washProgress: number; // 0–1 progress toward a zone-dwell wash; 0 when hands are outside the wash zone
  fps: number;
}
