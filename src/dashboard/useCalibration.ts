// Operator calibration on the dashboard: zone outlines, tong faces (ArUco) and A4 touch heights, drawn on the
// camera feed. Same rules and wording as the vision dev page (vision/calibration.ts); both pages share storage.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Point, ToolContactTarget, ZonedObjectId } from "../shared/config";
import {
  CALIBRATION_CANCELLED, CALIBRATION_CLEARED, CALIBRATION_IDLE_HELP, CALIBRATION_STEPS, CLOSE_RADIUS_PX, DEMO_LAYOUT_HELP,
  DRAW_HELP, MIN_VERTEX_GAP_PX, STORAGE_UNAVAILABLE_TONGS, STORAGE_UNAVAILABLE_ZONES, TOUCH_CANCELLED, ZONE_IDLE_HELP,
  calibratedMessage, demoLayout, emptyZones, finishCalibrationStep, finishZoneDraft, startCalibrationError, touchCaptureFace,
  touchFailedMessage, touchRecordingMessage, touchSavedMessage, withMarkerEntry, withTouchSide,
} from "../vision/calibration";
import type { TongCalibration } from "../vision/calibration";
import { addTouchFrame, createTouchCapture } from "../vision/touch";
import type { TouchCapture } from "../vision/touch";
import { ZONE_LABELS } from "./labels";
import type { LiveVision } from "./useLiveVision";

/** On-screen size of the feed in CSS pixels, for click distances. */
export interface ScreenSize { width: number; height: number }

interface State {
  zone?: ZonedObjectId;
  tong?: TongCalibration;
  capture?: { markerId: number; target: ToolContactTarget };
  /** Vertices placed so far for the selected zone or tong step, in raw normalized coordinates. */
  draft: Point[];
  cursor?: Point;
  /** The pointer is close enough to the first corner that a click closes the outline. */
  closing: boolean;
  zoneHelp: string;
  tongHelp: string;
}

export interface Calibration extends Readonly<State> {
  /** A zone or tong step is taking clicks on the feed. */
  drawing: boolean;
  /** The instruction for the current drawing step, shown on the feed. */
  prompt: string | null;
  pointerDown(point: Point, screen: ScreenSize): void;
  pointerMove(point: Point, screen: ScreenSize): void;
  pointerLeave(): void;
  toggleZone(id: ZonedObjectId): void;
  applyDemoLayout(): void;
  clearZones(): void;
  toggleFace(markerId: number): void;
  toggleTouch(target: ToolContactTarget): void;
  clearTongs(): void;
}

const zoneLabel = (id: ZonedObjectId) => ZONE_LABELS[id];
const distance = (a: Point, b: Point, screen: ScreenSize) => Math.hypot((a[0] - b[0]) * screen.width, (a[1] - b[1]) * screen.height);

export function useCalibration(vision: LiveVision): Calibration {
  const [state, setState] = useState<State>({ draft: [], closing: false, zoneHelp: ZONE_IDLE_HELP, tongHelp: CALIBRATION_IDLE_HELP });
  // Handlers read the latest state and vision through a ref, so the keyboard and marker listeners never go
  // stale, and a handler that updates and then finishes a step sees its own update.
  const latest = useRef({ state, vision });
  latest.current = { state, vision };
  const update = useCallback((patch: Partial<State>) => {
    const next = { ...latest.current.state, ...patch };
    latest.current.state = next;
    setState(next);
  }, []);
  const live = vision.phase === "live";

  const endTong = (tongHelp?: string) =>
    update({ tong: undefined, draft: [], cursor: undefined, closing: false, ...(tongHelp !== undefined ? { tongHelp } : {}) });

  const saveModels = (next: Parameters<LiveVision["saveUtensilModels"]>[0], tongHelp: string) => {
    const stored = latest.current.vision.saveUtensilModels(next);
    update({ tongHelp: stored ? tongHelp : STORAGE_UNAVAILABLE_TONGS });
  };

  const finishDraft = () => {
    const { state: s, vision: v } = latest.current;
    if (s.tong) {
      const result = finishCalibrationStep(s.tong, s.draft);
      if (result.kind === "error") update({ tongHelp: result.message });
      else if (result.kind === "failed") endTong(result.message);
      else if (result.kind === "next") update({ tong: result.calibration, draft: [], closing: false, tongHelp: result.message });
      else {
        const next = withMarkerEntry(v.utensilModels, result.entry);
        endTong();
        saveModels(next, calibratedMessage(next, result.entry.markerId));
      }
      return;
    }
    if (!s.zone) return;
    const result = finishZoneDraft(v.zones, s.zone, s.draft, zoneLabel);
    if ("error" in result) { update({ zoneHelp: result.error }); return; }
    const stored = v.saveZones(result.zones);
    update({ zone: undefined, draft: [], cursor: undefined, closing: false, zoneHelp: stored ? result.message : STORAGE_UNAVAILABLE_ZONES });
  };

  const canClose = (s: State, cursor: Point, screen: ScreenSize) =>
    s.tong?.step !== "jaws" && s.draft.length >= 3 && distance(cursor, s.draft[0]!, screen) <= CLOSE_RADIUS_PX;

  const pointerDown = (point: Point, screen: ScreenSize) => {
    const s = latest.current.state;
    if ((!s.zone && !s.tong) || !live) return;
    const last = s.draft[s.draft.length - 1];
    if (s.tong?.step === "jaws") {
      if (last && distance(point, last, screen) < MIN_VERTEX_GAP_PX) return;
      update({ draft: [...s.draft, point], cursor: point });
      if (s.draft.length + 1 === 2) finishDraft(); // at most two jaw ends
      return;
    }
    if (canClose(s, point, screen)) { finishDraft(); return; }
    if (last && distance(point, last, screen) < MIN_VERTEX_GAP_PX) return;
    update({ draft: [...s.draft, point], cursor: point, closing: false });
  };

  const pointerMove = (point: Point, screen: ScreenSize) => {
    const s = latest.current.state;
    if ((s.zone || s.tong) && s.draft.length) update({ cursor: point, closing: canClose(s, point, screen) });
  };

  /** Switching zones (or deselecting) always discards an unfinished outline, and any tong calibration. */
  const selectZone = (zone: ZonedObjectId | undefined) => update({
    zone, draft: [], cursor: undefined, closing: false,
    zoneHelp: zone ? `Outline ${zoneLabel(zone)}. ${DRAW_HELP}` : ZONE_IDLE_HELP,
    ...(zone ? { tong: undefined } : {}),
  });

  const toggleZone = (id: ZonedObjectId) => selectZone(latest.current.state.zone === id ? undefined : id);

  const applyDemoLayout = () => {
    const stored = latest.current.vision.saveZones(demoLayout());
    update({ zone: undefined, draft: [], cursor: undefined, zoneHelp: stored ? DEMO_LAYOUT_HELP : STORAGE_UNAVAILABLE_ZONES });
  };

  const clearZones = () => {
    const stored = latest.current.vision.saveZones(emptyZones());
    update({ zone: undefined, draft: [], cursor: undefined, zoneHelp: stored ? ZONE_IDLE_HELP : STORAGE_UNAVAILABLE_ZONES });
  };

  const toggleFace = (markerId: number) => {
    const { state: s, vision: v } = latest.current;
    update({ capture: undefined });
    if (s.tong?.markerId === markerId) { endTong(CALIBRATION_CANCELLED); return; }
    // Freeze the tag as it is now: the outlines are measured against this one pose.
    const marker = live ? v.frame?.markers.find(m => m.id === markerId) : undefined;
    if (!marker) { endTong(startCalibrationError(markerId)); return; }
    update({
      zone: undefined, draft: [], cursor: undefined, closing: false, zoneHelp: ZONE_IDLE_HELP,
      tong: { markerId, corners: marker.corners, step: "tongs-tip", parts: {} },
      tongHelp: `ID ${markerId}: ${CALIBRATION_STEPS["tongs-tip"]}`,
    });
  };

  const toggleTouch = (target: ToolContactTarget) => {
    const { state: s, vision: v } = latest.current;
    if (s.capture?.target === target) { update({ capture: undefined, tongHelp: TOUCH_CANCELLED }); return; }
    const aspect = v.size ? v.size.width / v.size.height : 1;
    const face = touchCaptureFace(live ? v.frame?.markers ?? [] : [], v.utensilModels, v.zones, target, aspect, zoneLabel);
    if ("error" in face) { update({ tongHelp: face.error }); return; }
    update({ tong: undefined, draft: [], cursor: undefined, closing: false,
      capture: { markerId: face.markerId, target }, tongHelp: touchRecordingMessage(face.markerId, target) });
  };

  const clearTongs = () => {
    update({ capture: undefined });
    endTong();
    saveModels({}, CALIBRATION_CLEARED);
  };

  // A4 touch capture: fed every marker frame (not React's batched renders) until it saves or refuses.
  const { capture } = state;
  useEffect(() => {
    if (!capture) return;
    const recording: TouchCapture = createTouchCapture(capture.markerId, capture.target, performance.now());
    let finished = false;
    const unsubscribe = latest.current.vision.addMarkerListener((markers, frame) => {
      const v = latest.current.vision;
      const entry = v.utensilModels.tongs?.markers.find(m => m.markerId === recording.markerId);
      if (finished) return;
      if (!entry) { finished = true; update({ capture: undefined }); return; }
      const result = addTouchFrame(recording, markers, entry, v.zones[recording.target], frame.width / frame.height, performance.now());
      if (!result.done) return;
      finished = true;
      update({ capture: undefined });
      if ("error" in result) update({ tongHelp: touchFailedMessage(recording.markerId, recording.target, result.error) });
      else saveModels(withTouchSide(v.utensilModels, recording.markerId, recording.target, result.side),
        touchSavedMessage(recording.markerId, recording.target));
    });
    return unsubscribe; // saveModels and update read everything through refs
  }, [capture]);

  // Stopping the camera ends any drawing or capture; nothing unfinished is saved.
  useEffect(() => {
    if (!live) update({ zone: undefined, tong: undefined, capture: undefined, draft: [], cursor: undefined, closing: false });
  }, [live, update]);

  const drawing = live && (!!state.zone || !!state.tong);
  useEffect(() => {
    if (!drawing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
      const s = latest.current.state;
      if (event.key === "Enter") finishDraft();
      else if (event.key === "Backspace" && s.draft.length) update({ draft: s.draft.slice(0, -1), closing: false });
      else if (event.key === "Escape") { if (s.tong) endTong(CALIBRATION_CANCELLED); else selectZone(undefined); }
      else return;
      event.preventDefault(); // stops Enter from also "clicking" the focused button
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey); // the handlers read everything through refs
  }, [drawing]);

  return {
    ...state, drawing,
    prompt: !drawing ? null : state.tong ? state.tongHelp : state.zoneHelp,
    pointerDown, pointerMove, pointerLeave: () => update({ cursor: undefined, closing: false }),
    toggleZone, applyDemoLayout, clearZones, toggleFace, toggleTouch, clearTongs,
  };
}
