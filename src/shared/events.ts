// GhostTrace shared event schema — the ONLY way anything changes engine state.
// Engine state is a pure function of the ordered event log: replaying the same
// events always produces the same state. Spec: GhostTrace-summary-v5.md.

import type { ContactTarget, Polygon, ToolContactTarget, ToolSurface, UtensilId } from "./config";

export type EventSource = "camera" | "manual" | "sim";
export type WashMethod = "zone-dwell" | "motion" | "manual-tap" | "manual-voice";

interface EventBase {
  /** Unique per event. Use crypto.randomUUID(); the engine ignores repeated ids. */
  id: string;
  /** Milliseconds from performance.now() in this browser tab (one monotonic clock). */
  t: number;
}

/** Who touched what. Hands touch any target; a tong part touches only static targets, never the other part. */
export type ContactPair =
  | { a: "hands"; b: ContactTarget } // b is "tongs-tip" or "tongs-handle", never "tongs"
  | { a: ToolSurface; b: ToolContactTarget };

/**
 * Two surfaces overlapped long enough to count as one touch. Fires after dwell, then
 * re-fires every heldContactRefireMs while the pair stays occupied (each with a new id).
 */
export type ContactEvent = EventBase & ContactPair & {
  kind: "contact";
  /** Fraction (0–1) of dwell-window frames with overlap; tool contacts count only "tracked" frames. NOT a probability of physical contact. */
  confidence: number;
  source: "camera" | "sim";
};

/** Hands were washed. Clears tracked exposure on "hands" ONLY. Never certifies cleanliness. */
export interface WashEvent extends EventBase {
  kind: "wash";
  method: WashMethod;
  durationMs?: number; // time in the wash zone, for camera-detected washes
  source: EventSource; // "camera" for zone-dwell/motion; "manual" for tap/voice; "sim" in simulation
  verified: false; // always false
}

/**
 * A3: hands and this utensil's jaw ends stayed in the sink together for washDwellMs. Vision always sends it
 * directly after the hand `wash` from the same dwell. Resets ALL surfaces of that utensil. Never certifies cleanliness.
 */
export interface UtensilWashedEvent extends EventBase {
  kind: "utensil-washed";
  utensilId: UtensilId;
  method: "zone-dwell";
  durationMs?: number; // time the jaw ends and hands spent in the sink together
  source: "camera" | "sim";
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
  | UtensilWashedEvent
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
  /** A3: 0–1 progress toward a utensil wash; 0 unless the hands and a tong jaw end are both in the sink. */
  utensilWashProgress: number;
  fps: number;
  /** Tool→target pairs overlapping right now (before dwell), for the overlay. */
  activeToolContacts: { a: ToolSurface; b: ToolContactTarget }[];
  utensils: Record<UtensilId, UtensilPoseStatus>;
}

/** "fixed" = no marker model calibrated: the static ZoneLayout polygons are used (v4 behaviour). */
export type UtensilTracking = "tracked" | "held" | "lost" | "fixed";

export interface UtensilPoseStatus {
  tracking: UtensilTracking;
  /** Current part polygons in the raw frame; null while lost. */
  parts: Record<ToolSurface, Polygon> | null;
  lastSeenT: number | null;
}
