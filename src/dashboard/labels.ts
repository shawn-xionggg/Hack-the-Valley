// Every piece of dashboard wording that depends on engine or vision state lives here, so the spec §3.3
// labels can be checked in one place (labels.test.ts). No text may say safe, clean, allergen-free or verified
// (invariant 5), except the required "not verified" wash label.

import type { ExposableSurfaceId, ToolSurface } from "../shared/config";
import type { ChainStep, LogEffect, LoggedEvent, SurfaceStatus } from "../shared/engine-types";
import type { UtensilTracking, WashMethod } from "../shared/events";

/** Card order on the dashboard: the path exposure takes in the demo. */
export const SURFACE_ORDER: ExposableSurfaceId[] = ["peanut-source", "hands", "tongs-tip", "tongs-handle", "meal-1"];

export const SURFACE_LABELS: Record<ExposableSurfaceId, string> = {
  hands: "Hands",
  "peanut-source": "Allergen source",
  "tongs-tip": "Tong tips",
  "tongs-handle": "Tong handle",
  "meal-1": "Meal · Order #4",
};

export const STATUS_LABELS: Record<SurfaceStatus, string> = {
  "no-tracked-exposure": "No tracked exposure",
  "potential-exposure": "Potential peanut exposure",
  "action-required": "Action required — hold meal",
};

/** peanut-source is always potential-exposure internally; the card says what it is instead. */
export const SOURCE_LABEL = "Allergen source";

export const WASH_METHODS: Record<WashMethod, string> = {
  "zone-dwell": "zone dwell",
  motion: "washing motion",
  "manual-tap": "manual confirmation",
  "manual-voice": "voice confirmation",
};

export const WASH_LABEL = "Hands washed (detected, not verified)";

/** Badges on the tip and handle cards. Tracked and held need none: the cards' statuses are live. */
export const TRACKING_NOTES: Partial<Record<UtensilTracking, string>> = {
  lost: "Tong tracking lost — contacts not recorded",
  fixed: "Tongs: fixed position",
};

/** Shown in the camera status strip. */
export const TRACKING_LABELS: Record<UtensilTracking, string> = {
  tracked: "Tracked",
  held: "Held (last pose)",
  lost: "Tracking lost",
  fixed: "Fixed position",
};

export const HANDS_OUT_OF_VIEW = "Hands not in view — contacts not recorded";

export const EFFECT_LABELS: Record<LogEffect, string> = {
  applied: "applied",
  "no-change": "no change",
  "ignored-low-confidence": "ignored · low confidence",
  "ignored-duplicate-id": "ignored · duplicate",
  "ignored-unknown-alert": "ignored · unknown alert",
  "ignored-invalid-contact": "ignored · invalid pair",
};

/** Shown under the cards only while a tong part has tracked exposure: replacement is the only tong reset (§3.2). */
export const TONGS_REPLACE_PROMPT = "The tongs have tracked exposure. Swap them for a fresh pair, then confirm.";
export const TONGS_REPLACE_BUTTON = "Confirm tongs replaced";
export const MANUAL_WASH_BUTTON = "Confirm hands washed with soap and water";
export const MANUAL_WASH_NOTE = "Fallback for when camera wash detection isn't reliable (spec §4.5).";

export const CORRECTIVE_ACTION ="Hold this meal and prepare a replacement with appropriate allergen controls.";
export const ACK_NOTE = "Acknowledged. The meal stays on hold until the session is reset.";
export const SCOPE_NOTE =
  "Exposure is inferred from 2D camera geometry. GhostTrace does not test for allergens and does not confirm cleaning.";

const isTool = (id: ExposableSurfaceId): id is ToolSurface => id === "tongs-tip" || id === "tongs-handle";

export function washText(method: WashMethod): string {
  return `${WASH_LABEL} · ${WASH_METHODS[method]}`;
}

/** One line per chain step. A tool contact never involves the hands (§2), so it reads as the tool touching the target. */
export function chainStepText(step: ChainStep): string {
  switch (step.kind) {
    case "origin":
      return `${SURFACE_LABELS[step.surfaceId]} (${step.allergen})`;
    case "wash":
      return washText(step.method);
    case "transfer":
      if (isTool(step.from) && step.to !== "hands") return `${SURFACE_LABELS[step.from]} touched ${SURFACE_LABELS[step.to]}`;
      if (isTool(step.to) && step.from !== "hands") return `${SURFACE_LABELS[step.to]} touched ${SURFACE_LABELS[step.from]}`;
      return `${SURFACE_LABELS[step.from]} → ${SURFACE_LABELS[step.to]}`;
  }
}

export function eventText({ event }: LoggedEvent): string {
  switch (event.kind) {
    case "contact":
      return `${SURFACE_LABELS[event.a]} ↔ ${SURFACE_LABELS[event.b]} · ${Math.round(event.confidence * 100)}%`;
    case "wash":
      return washText(event.method);
    case "utensil-replaced-confirmed":
      return "Tongs replaced (confirmed by staff)";
    case "alert-acknowledged":
      return "Alert acknowledged";
    case "session-reset":
      return "Session reset";
  }
}

/** performance.now() timestamps → wall-clock time for display. */
export function clockTime(t: number, now = performance.now(), wall = Date.now()): string {
  return new Date(wall - (now - t)).toLocaleTimeString();
}

/**
 * The chain as a one-line path, as in the pitch (spec §1):
 * Allergen source → Hands → Tong tips → [Hands washed] → Tong tips → Hands → Meal · Order #4.
 * Each transfer adds its target; its source is repeated only after a wash, to show where exposure picked up again.
 */
export function chainPath(chain: readonly ChainStep[]): string[] {
  const path: string[] = [];
  let afterWash = false;
  for (const step of chain) {
    if (step.kind === "origin") path.push(SURFACE_LABELS[step.surfaceId]);
    else if (step.kind === "wash") { path.push("[Hands washed]"); afterWash = true; }
    else {
      if (afterWash) path.push(SURFACE_LABELS[step.from]);
      path.push(SURFACE_LABELS[step.to]);
      afterWash = false;
    }
  }
  return path;
}
