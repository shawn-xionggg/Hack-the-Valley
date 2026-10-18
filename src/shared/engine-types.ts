// Allos engine API and state shape — what the dashboard renders and what
// the engine (Person 2) must implement. Spec: Allos-summary-v5.md.

import type {
  Allergen,
  ContactTarget,
  ExposableSurfaceId,
  MealId,
  Order,
  Tuning,
  UtensilId,
} from "./config";
import type { AllosEvent, WashMethod } from "./events";

/**
 * "no-tracked-exposure": the engine has recorded no potential exposure on this surface
 *   since the session started or since its last reset (wash for hands, replacement or
 *   utensil wash for a utensil). It does NOT mean safe or clean.
 * "potential-exposure": at least one allergen may have reached this surface through
 *   observed contacts.
 * "action-required": a meal has potential exposure to an allergen its order declares.
 *   Stays until that meal or the session is reset, even after acknowledgement.
 */
export type SurfaceStatus = "no-tracked-exposure" | "potential-exposure" | "action-required";

/** One allergen arriving on one surface. Append-only: never deleted, only marked cleared. */
export interface ExposureRecord {
  id: string;
  surfaceId: ExposableSurfaceId;
  allergen: Allergen;
  /** "origin" = the surface is an allergen source (created at session start). */
  kind: "origin" | "transfer";
  /** Contact event that created it; null for origins. */
  causedByEventId: string | null;
  /** Surface the allergen came from; null for origins. */
  fromSurfaceId: ExposableSurfaceId | null;
  /** The record on fromSurfaceId that was active at the time (provenance pointer); null for origins. */
  parentRecordId: string | null;
  t: number;
  /** Wash, replacement or meal-reset event that cleared it; null while active. */
  clearedByEventId: string | null;
}

export interface SurfaceState {
  id: ExposableSurfaceId;
  status: SurfaceStatus;
  allergens: Allergen[]; // allergens with an active record
  activeRecordIds: string[];
}

export type ChainStep =
  | { kind: "origin"; surfaceId: ExposableSurfaceId; allergen: Allergen; recordId: string }
  | {
      kind: "transfer";
      from: ExposableSurfaceId;
      to: ExposableSurfaceId;
      allergen: Allergen;
      eventId: string;
      recordId: string;
      t: number;
    }
  | { kind: "wash"; eventId: string; method: WashMethod; t: number };

export interface Alert {
  id: string;
  orderId: string;
  mealId: MealId;
  allergen: Allergen;
  triggeredByEventId: string;
  t: number;
  acknowledged: boolean;
  acknowledgedAt: number | null;
  /** Time-ordered explanation: origin, transfers, and any washes that cleared an ancestor record. */
  chain: ChainStep[];
}

export type LogEffect =
  | "applied" // changed state
  | "no-change" // valid, but nothing new (e.g. clean hands touching a clean surface)
  | "ignored-low-confidence"
  | "ignored-duplicate-id"
  | "ignored-unknown-alert"
  | "ignored-invalid-contact"; // contact pair not allowed (tip↔handle, a === b, tool↔tool)

export interface LoggedEvent {
  event: AllosEvent;
  effect: LogEffect;
}

export interface EngineState {
  sessionId: string;
  surfaces: Record<ExposableSurfaceId, SurfaceState>;
  records: ExposureRecord[];
  alerts: Alert[];
  log: LoggedEvent[];
  /** Method of the most recent wash, for the "Hands washed (detected, not verified)" label. */
  lastWash: { eventId: string; method: WashMethod; t: number } | null;
  /** A3: the most recent utensil wash, for the "Tongs washed (detected, not verified)" label. */
  lastUtensilWash: { eventId: string; utensilId: UtensilId; method: "zone-dwell"; t: number } | null;
}

export interface EngineOptions {
  orders?: Order[]; // defaults to ORDERS from config
  tuning?: Partial<Tuning>; // defaults to DEFAULT_TUNING
}

export interface Engine {
  /** Apply one event; returns the new state. Never throws on bad input — it logs an ignored effect instead. */
  dispatch(event: AllosEvent): EngineState;
  getState(): EngineState;
  /** Called after every dispatch. Returns an unsubscribe function. */
  subscribe(listener: (state: EngineState) => void): () => void;
}

export type CreateEngine = (options?: EngineOptions) => Engine;

/** Convenience for UIs: which zone a contact touched (for highlighting). */
export type HighlightTarget = ContactTarget;
