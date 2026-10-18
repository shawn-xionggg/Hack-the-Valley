import { SURFACES } from "../shared/config";
import type { Point, Polygon, ToolContactTarget, ToolSurface, UtensilMarkerModel, UtensilModels, ZoneLayout, ZonedObjectId } from "../shared/config";
import { MIN_MARKER_SIDE_PX, TONG_MARKER_IDS, markerSidePx } from "./aruco";
import type { DetectedMarker, MarkerFrame } from "./aruco";
import { overlappingZones, polygonsOverlap, validatePolygon } from "./geometry";
import { calibrateMarker, poseFromMarkers } from "./pose";

// Calibration rules and wording shared by the vision dev page and the dashboard's operator controls.
// Pure: both pages own their own drawing state and feed it through these.

export const CALIBRATION_ZONE_IDS: ZonedObjectId[] = ["peanut-source", "tongs-tip", "tongs-handle", "meal-1", "wash-station"];
export const emptyZones = (): ZoneLayout => ({ "peanut-source": [], "tongs-tip": [], "tongs-handle": [], "meal-1": [], "wash-station": [] });

/** Placeholder zones across the bottom of the frame. They don't locate real surfaces. */
export function demoLayout(): ZoneLayout {
  const zones = emptyZones();
  CALIBRATION_ZONE_IDS.forEach((id, i) => { const x = 0.035 + i * 0.195; zones[id] = [[x, 0.6], [x + 0.15, 0.6], [x + 0.15, 0.93], [x, 0.93]]; });
  return zones;
}
export const DEMO_LAYOUT_HELP = "Demo zones placed along the bottom of the frame. These are placeholders; calibrate them to match your surfaces.";

export const CLOSE_RADIUS_PX = 12; // clicking this close to the first vertex closes the polygon
export const MIN_VERTEX_GAP_PX = 6; // clicks this close to the previous vertex are ignored (double-clicks)
export const DRAW_HELP = "Click to place corners. Click the first corner or press Enter to finish · Backspace undoes · Esc cancels.";
export const ZONE_IDLE_HELP = "Zones are saved on this device. Recalibrate after moving the camera or switching cameras.";
export const CALIBRATION_IDLE_HELP = "Lay the tongs flat and closed with one marker face up, then calibrate that face. Repeat with the tongs flipped. Keep them still while you draw. Optional height gate: with each face up, rest the jaw ends on the plate and record, then in the peanuts. Recalibrating a face clears its touches.";
export const CALIBRATION_CANCELLED = "Calibration cancelled. Nothing was saved.";
export const CALIBRATION_CLEARED = "Calibration cleared. The tongs use their fixed zones until a face is calibrated.";
export const TOUCH_CANCELLED = "Touch recording cancelled. Nothing was saved.";
export const STORAGE_UNAVAILABLE_ZONES = "Browser storage is unavailable. These zones will last for this session only.";
export const STORAGE_UNAVAILABLE_TONGS = "Browser storage is unavailable. This calibration will last for this session only.";

/**
 * Tong calibration for one face (§4.4): the marker's corners are frozen when it starts, then the
 * tip and handle are outlined and the jaw ends clicked, all on the raw frame.
 */
export type CalibrationStep = ToolSurface | "jaws";
export interface TongCalibration { markerId: number; corners: Point[]; step: CalibrationStep; parts: Partial<Record<ToolSurface, Polygon>> }
export const CALIBRATION_STEPS: Record<CalibrationStep, string> = {
  "tongs-tip": `Outline the tong tips. Pad the outline past the jaws so open jaws stay inside. ${DRAW_HELP}`,
  "tongs-handle": `Outline the handle, leaving a gap over the hinge. ${DRAW_HELP}`,
  jaws: "Click the jaw end (one or two points), then press Enter · Backspace undoes · Esc cancels.",
};

export const TOUCH_TARGETS: ToolContactTarget[] = ["meal-1", "peanut-source"];
export const TOUCH_LABELS: Record<ToolContactTarget, string> = { "meal-1": "plate", "peanut-source": "peanut" };

type Label = (id: ZonedObjectId) => string;
const surfaceLabel: Label = id => SURFACES[id].label;

/** Saved anyway (the tracker can cope), but the person calibrating should know why it's risky. */
export function overlapWarning(id: ZonedObjectId, others: ZonedObjectId[], label: Label = surfaceLabel): string {
  const isTongPair = (other: ZonedObjectId) => SURFACES[id].utensilId !== undefined && SURFACES[id].utensilId === SURFACES[other].utensilId;
  const reasons = [
    others.some(isTongPair) && "Leave a gap over the hinge so tip and handle touches can't be confused.",
    others.some(other => !isTongPair(other)) && "A touch in the shared area counts for both zones.",
  ].filter(Boolean).join(" ");
  return `⚠ ${label(id)} saved, but it overlaps ${others.map(label).join(", ")}. ${reasons}`;
}

/** Saves a finished outline into the layout, or says why it can't be saved. */
export function finishZoneDraft(
  zones: ZoneLayout, id: ZonedObjectId, draft: Point[], label: Label = surfaceLabel,
): { error: string } | { zones: ZoneLayout; message: string } {
  const error = validatePolygon(draft);
  if (error) return { error };
  const next = { ...zones, [id]: draft };
  const others = overlappingZones(next).flatMap(([a, b]) => a === id ? [b] : b === id ? [a] : []);
  return { zones: next, message: others.length ? overlapWarning(id, others, label) : `${label(id)} saved. Select another surface to outline it.` };
}

export function startCalibrationError(markerId: number): string {
  return `ID ${markerId} isn't in view. Lay the tongs flat and closed with ID ${markerId} face up, then try again.`;
}

export type CalibrationStepResult =
  | { kind: "error"; message: string }
  | { kind: "next"; calibration: TongCalibration; message: string }
  | { kind: "done"; entry: UtensilMarkerModel }
  | { kind: "failed"; message: string };

/** Finishes the current step with the drawn points: an outline for tip and handle, one or two jaw ends last. */
export function finishCalibrationStep(c: TongCalibration, draft: Point[]): CalibrationStepResult {
  if (c.step !== "jaws") {
    const error = validatePolygon(draft);
    if (error) return { kind: "error", message: error };
    const parts = { ...c.parts, [c.step]: draft };
    const step: CalibrationStep = c.step === "tongs-tip" ? "tongs-handle" : "jaws";
    const tip = parts["tongs-tip"], handle = parts["tongs-handle"];
    const hinge = tip && handle && polygonsOverlap(tip, handle) ? "⚠ Tip and handle overlap: a gap over the hinge keeps their touches apart. " : "";
    return { kind: "next", calibration: { ...c, step, parts }, message: `ID ${c.markerId}: ${hinge}${CALIBRATION_STEPS[step]}` };
  }
  const tip = c.parts["tongs-tip"], handle = c.parts["tongs-handle"];
  if (!draft.length) return { kind: "error", message: `ID ${c.markerId}: click at least one jaw end first.` };
  if (!tip || !handle) return { kind: "failed", message: CALIBRATION_CANCELLED };
  const entry = calibrateMarker(c.markerId, c.corners, { "tongs-tip": tip, "tongs-handle": handle }, draft);
  return entry ? { kind: "done", entry }
    : { kind: "failed", message: `ID ${c.markerId}: the marker outline was too distorted to calibrate. Lay the tongs flat and try again.` };
}

/** Replaces that face's entry. A fresh entry has no touch references, so recalibrating a face drops them (A4). */
export function withMarkerEntry(models: UtensilModels, entry: UtensilMarkerModel): UtensilModels {
  return { tongs: { markers: [...(models.tongs?.markers ?? []).filter(m => m.markerId !== entry.markerId), entry] } };
}

export function calibratedMessage(models: UtensilModels, markerId: number): string {
  const missing = TONG_MARKER_IDS.filter(id => !models.tongs?.markers.some(m => m.markerId === id));
  return `ID ${markerId} calibrated.${missing.length ? ` Flip the tongs and calibrate ID ${missing.join(", ")}.` : " Both faces are calibrated."}`;
}

export function withTouchSide(models: UtensilModels, markerId: number, target: ToolContactTarget, side: number): UtensilModels {
  const markers = models.tongs?.markers ?? [];
  return { tongs: { markers: markers.map(m => m.markerId === markerId ? { ...m, touchSides: { ...m.touchSides, [target]: side } } : m) } };
}

/** The face a touch capture would record, or why it can't start. */
export function touchCaptureFace(
  markers: readonly DetectedMarker[], models: UtensilModels, zones: ZoneLayout, target: ToolContactTarget, aspect: number,
  label: Label = surfaceLabel,
): { markerId: number } | { error: string } {
  // The face that would place the tongs right now: the larger visible calibrated marker, as in poseFromMarkers.
  const face = poseFromMarkers(markers, { markers: models.tongs?.markers ?? [] }, aspect);
  if (!face) return { error: `No calibrated face is in view. Rest the jaw ends on the ${TOUCH_LABELS[target]} with a calibrated face up, then try again.` };
  if (validatePolygon(zones[target])) return { error: `Calibrate the ${label(target)} zone first.` };
  return { markerId: face.markerId };
}

export const touchRecordingMessage = (markerId: number, target: ToolContactTarget) =>
  `Recording ID ${markerId} on the ${TOUCH_LABELS[target]}. Keep the jaw ends resting on it for a second…`;
export const touchFailedMessage = (markerId: number, target: ToolContactTarget, error: string) =>
  `ID ${markerId} ${TOUCH_LABELS[target]} touch not saved: ${error}`;
export const touchSavedMessage = (markerId: number, target: ToolContactTarget) =>
  `ID ${markerId} ${TOUCH_LABELS[target]} touch saved. Tool contacts with it now need the tips down at this height`
  + (target === "peanut-source" ? ", and so does a tong wash at the sink (same rim height)." : ".");

export function calibratedFacesText(models: UtensilModels): string {
  const calibrated = new Set(models.tongs?.markers.map(m => m.markerId));
  return TONG_MARKER_IDS.map(id => `${id} ${calibrated.has(id) ? "✓" : "—"}`).join(" · ");
}

export function touchRefsText(models: UtensilModels): string {
  return models.tongs?.markers.map(m =>
    `${m.markerId} ${TOUCH_TARGETS.map(target => `${TOUCH_LABELS[target]} ${m.touchSides?.[target] ? "✓" : "—"}`).join(" ")}`).join(" · ") || "None";
}

/** Each visible tag's side in pixels (§4.4: ≥ 30 px), and its live side over each recorded touch reference (A4). */
export function markerStatusText(markers: readonly DetectedMarker[], frame: MarkerFrame, models: UtensilModels): string {
  const aspect = frame.width / frame.height;
  return markers.length ? markers.map(m => {
    const side = Math.round(markerSidePx(m, frame.width, frame.height));
    return `${m.id} · ${side} px${side < MIN_MARKER_SIDE_PX ? " ⚠" : ""}${touchRatios(m, aspect, models)}`;
  }).join(", ") : "No markers visible";
}

/** A4: above 1 + toolContactSideMargin, that target is gated. */
function touchRatios(marker: DetectedMarker, aspect: number, models: UtensilModels): string {
  const entry = models.tongs?.markers.find(m => m.markerId === marker.id);
  const side = entry && poseFromMarkers([marker], { markers: [entry] }, aspect)?.markerSide;
  if (!entry?.touchSides || !side) return "";
  return TOUCH_TARGETS.flatMap(target => {
    const reference = entry.touchSides?.[target];
    return reference ? [` · ×${(side / reference).toFixed(2)} ${TOUCH_LABELS[target]}`] : [];
  }).join("");
}
