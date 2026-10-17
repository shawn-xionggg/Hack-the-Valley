import "./style.css";
import { SURFACES, UTENSIL_MODELS_STORAGE_KEY, ZONE_LAYOUT_STORAGE_KEY } from "./shared/config";
import type { Point, Polygon, ToolSurface, UtensilModels, ZoneLayout, ZonedObjectId } from "./shared/config";
import type { ContactEvent, VisionStatus, WashEvent } from "./shared/events";
import type { VisionHandle } from "./shared/vision-types";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { startVision } from "./vision";
import { mountEnginePanel } from "./engine-panel";
import { overlappingZones, polygonsOverlap, validatePolygon } from "./vision/geometry";
import { fixedUtensilStatus } from "./vision/tracker";
import { calibrateMarker, parseUtensilModels } from "./vision/pose";
import {
  GO_NO_GO_RATE, MIN_MARKER_SIDE_PX, TONG_MARKER_IDS, createMarkerSvg, createMarkerTrial, createTongMarkerSheet,
  drawMarkerBoxes, markerSidePx, recordMarkerFrame,
} from "./vision/aruco";
import type { DetectedMarker, MarkerTrial } from "./vision/aruco";

const zoneIds: ZonedObjectId[] = ["peanut-source", "tongs-tip", "tongs-handle", "meal-1", "wash-station"];
const colors = ["#f8bd72", "#baabff", "#84b8ff", "#fc91ac", "#79ddc1"];
const emptyZones = (): ZoneLayout => ({ "peanut-source": [], "tongs-tip": [], "tongs-handle": [], "meal-1": [], "wash-station": [] });
let zones = emptyZones();
try {
  const stored: unknown = JSON.parse(localStorage.getItem(ZONE_LAYOUT_STORAGE_KEY) ?? "null");
  if (stored && typeof stored === "object" && zoneIds.every(id => {
    const polygon: unknown = (stored as Record<string, unknown>)[id];
    return Array.isArray(polygon) && (polygon.length === 0 || polygon.length >= 3) && polygon.every(p =>
      Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1));
  })) zones = stored as ZoneLayout;
} catch { /* Storage can be unavailable; calibration still works for this session. */ }
let utensilModels: UtensilModels = {};
try { utensilModels = parseUtensilModels(JSON.parse(localStorage.getItem(UTENSIL_MODELS_STORAGE_KEY) ?? "null")); }
catch { /* As above: without stored models the tongs start "fixed". */ }

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar">
    <a class="brand" href="./" aria-label="GhostTrace home"><span class="brand-mark">g.</span> GhostTrace</a>
    <span class="top-note">VISION PROTOTYPE <span class="version">v0.1</span></span>
  </header>
  <main>
    <div class="page-heading"><div><p class="eyebrow">WORKSPACE / LIVE VISION</p><h1>A clear view of every move.</h1>
      <p class="subtitle">Connect a camera. Track hands. See contact events as they happen.</p></div>
      <span class="badge" id="badge">● Camera offline</span>
    </div>
    <div class="workspace">
      <section class="camera-panel panel" aria-label="Live camera">
        <div class="panel-heading"><h2><span class="small-dot"></span> Camera feed</h2><span class="mono" id="resolution">AWAITING CAMERA</span></div>
        <div class="stage" id="stage">
          <div class="feed" id="feed"><video id="video" autoplay muted playsinline></video><canvas id="overlay" aria-label="Hand landmarks and calibrated zones"></canvas></div>
          <div class="empty-state" id="empty"><div class="camera-icon" aria-hidden="true">◎</div><h3>Your workspace, in view.</h3><p>Start your camera to begin live hand tracking.<br />Frames are processed on this device.</p></div>
          <span class="stage-label">GHOSTTRACE / LIVE</span>
        </div>
        <div class="camera-toolbar"><div class="camera-select"><label for="camera">Camera source</label><select id="camera"><option value="">Default camera</option></select></div>
          <label class="check"><input type="checkbox" id="mirror" /> Mirror</label>
          <button class="primary" id="start">Start camera <span aria-hidden="true">↗</span></button><button class="secondary" id="stop" disabled>Stop</button>
        </div>
        <p id="message" class="message" role="status" aria-live="polite">Ready when you are. Camera access is requested when you start.</p>
      </section>
      <aside class="sidebar">
        <section class="panel status-panel"><div class="panel-heading"><h2>Live detection</h2><span class="pill">ON DEVICE</span></div>
          <div class="metrics"><div><strong id="hands">—</strong><span>Hands visible</span></div><div><strong id="fps">—</strong><span>Inference FPS</span></div></div>
          <div class="status-row"><span>Model</span><span id="model-state">Not loaded</span></div>
          <div class="status-row"><span>Landmarks</span><span id="landmarks">0 points</span></div>
          <div class="status-row"><span>Active zones</span><span id="active">None</span></div>
          <div class="wash-label"><label for="wash">Wash zone dwell</label><span id="wash-text">0%</span></div><progress id="wash" max="1" value="0"></progress>
          <p class="hint">Hold a hand in frame to see its landmarks. Up to two hands at a time.</p>
        </section>
        <section class="panel markers-panel"><div class="panel-heading"><h2>Tong markers</h2><span class="mono" id="marker-frame">—</span></div>
          <div class="status-row"><label class="check"><input type="checkbox" id="marker-enabled" checked /> ArUco boxes</label><span id="marker-status" role="status">Camera offline</span></div>
          <div class="status-row"><span>Tong tracking</span><span id="tong-tracking">—</span></div>
          <div class="status-row"><span>Calibrated faces</span><span id="calibrated-faces">None</span></div>
          <div class="zone-actions">${TONG_MARKER_IDS.map(id => `<button class="text-button" data-calibrate="${id}" disabled>Calibrate ID ${id}</button>`).join("")}<button class="text-button" id="clear-calibration">Clear calibration</button></div>
          <p class="hint" id="calibration-help"></p>
          <div class="zone-actions"><button class="text-button" id="print-markers">Print tong markers 11 + 12</button><button class="text-button" id="download-marker">Download test marker #0</button></div>
          <p class="hint">The tong sheet prints IDs 11 and 12 at 25 mm and 30 mm (OpenCV 4×4 / 50). Print at 100% and check its 50 mm bar.</p>
          <div class="status-row"><span>Go/no-go</span><span id="trial-summary">No trials yet</span></div>
          <div class="zone-actions"><button class="text-button" id="trial-toggle" disabled>Start trial (T)</button><button class="text-button" id="trial-clear" disabled>Clear trials</button></div>
          <ol id="trial-list" class="trial-list"></ol>
          <p class="hint">Press T as the dip starts and again after the serve. Do 10 trials, 5 with each face up. A trial passes at ${GO_NO_GO_RATE * 100}% of frames showing ID 11 or 12.</p>
        </section>
        <section class="panel zones-panel"><div class="panel-heading"><h2>Contact zones</h2><span class="mono" id="zone-count">0 / 5</span></div>
          <p class="hint zone-intro">Select a surface, then click its corners on the camera to outline its area.</p>
          <div id="zone-list" class="zone-list">${zoneIds.map((id, i) => `<button class="zone-button" data-zone="${id}" aria-pressed="false"><span class="zone-dot" style="background:${colors[i]}"></span><span>${SURFACES[id].label}</span><span class="zone-state">Unset</span></button>`).join("")}</div>
          <div class="zone-actions"><button class="text-button" id="presets">Use demo layout</button><button class="text-button" id="clear-zones">Clear zones</button></div>
          <p class="hint" id="zone-help">Zones are saved on this device. Recalibrate after moving the camera or switching cameras.</p>
        </section>
      </aside>
    </div>
    <section class="panel engine-panel" id="engine-panel" aria-label="Exposure tracking"></section>
    <section class="panel events-panel"><div class="panel-heading"><h2>Activity <span id="event-count" class="count">0</span></h2><div><button class="text-button" id="export" disabled>Export JSON</button><button class="text-button" id="clear-events">Clear log</button></div></div>
      <div class="events-empty" id="events-empty">No contacts yet. Calibrate a zone and hold a fingertip inside it for 0.4 seconds.</div><ol id="events" class="events" aria-live="polite" aria-label="Recent contact and wash events"></ol>
    </section>
    <footer><span><span class="small-dot"></span> Local inference · No video uploads</span><span>Zone overlap estimates contact. Wash events are unverified.</span></footer>
  </main>`;

function el<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const enginePanel = mountEnginePanel(el("engine-panel"));
const video = el<HTMLVideoElement>("video");
const canvas = el<HTMLCanvasElement>("overlay");
const ctx = canvas.getContext("2d")!;
const start = el<HTMLButtonElement>("start");
const stop = el<HTMLButtonElement>("stop");
const camera = el<HTMLSelectElement>("camera");
const mirror = el<HTMLInputElement>("mirror");
const markerEnabled = el<HTMLInputElement>("marker-enabled");
let markers: DetectedMarker[] = [];
/** Jaw ends of the current tong pose (tracked or held), for the overlay. */
let jawPoints: Point[] | null = null;
/** The go/no-go trial being recorded, if any, and the finished ones. */
let trial: MarkerTrial | undefined;
const trials: MarkerTrial[] = [];
let stream: MediaStream | undefined;
let vision: VisionHandle | undefined;
let generation = 0;
let running = false;
let selectedZone: ZonedObjectId | undefined;
/**
 * Tong calibration for one face (§4.4): the marker's corners are frozen when it starts, then the
 * tip and handle are outlined and the jaw ends clicked, all on the raw frame.
 */
type CalibrationStep = ToolSurface | "jaws";
let calibration: { markerId: number; corners: Point[]; step: CalibrationStep; parts: Partial<Record<ToolSurface, Polygon>> } | undefined;
/** Vertices placed so far for the selected zone or calibration step, in raw normalized coordinates. */
let draft: Point[] = [];
let cursor: Point | undefined;
const CLOSE_RADIUS_PX = 12; // clicking this close to the first vertex closes the polygon
const MIN_VERTEX_GAP_PX = 6; // clicks this close to the previous vertex are ignored (double-clicks)
const DRAW_HELP = "Click to place corners. Click the first corner or press Enter to finish · Backspace undoes · Esc cancels.";
const IDLE_HELP = "Zones are saved on this device. Recalibrate after moving the camera or switching cameras.";
const CALIBRATION_IDLE_HELP = "Lay the tongs flat and closed with one marker face up, then calibrate that face. Repeat with the tongs flipped. Keep them still while you draw.";
const CALIBRATION_STEPS: Record<CalibrationStep, string> = {
  "tongs-tip": `Outline the tong tips. Pad the outline past the jaws so open jaws stay inside. ${DRAW_HELP}`,
  "tongs-handle": `Outline the handle, leaving a gap over the hinge. ${DRAW_HELP}`,
  jaws: "Click the jaw end (one or two points), then press Enter · Backspace undoes · Esc cancels.",
};
const TRACKING_LABELS: Record<VisionStatus["utensils"]["tongs"]["tracking"], string> = {
  tracked: "Tracked",
  held: "Held (last pose)",
  lost: "Tong tracking lost — contacts not recorded",
  fixed: "Tongs: fixed position",
};
let lastResults: HandLandmarkerResult | undefined;
let status: VisionStatus | undefined;
const events: (ContactEvent | WashEvent)[] = [];

function message(text: string, error = false) {
  el("message").textContent = text;
  el("message").classList.toggle("error", error);
}

/** Tip and handle follow the tracked pose; everything else (and fixed tongs) uses the static layout. */
function zonePolygon(id: ZonedObjectId): Polygon {
  const tongs = status?.utensils.tongs;
  if ((id === "tongs-tip" || id === "tongs-handle") && tongs && tongs.tracking !== "fixed") return tongs.parts?.[id] ?? [];
  return zones[id];
}

function tracePolygon(polygon: Polygon, w: number, h: number) {
  ctx.beginPath();
  polygon.forEach(([x, y], n) => n === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h));
  ctx.closePath();
}

function draftColor(): string {
  if (calibration) return calibration.step === "jaws" ? "#ffffff" : colors[zoneIds.indexOf(calibration.step)]!;
  return colors[zoneIds.indexOf(selectedZone!)] ?? "#ffffff";
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height;
  zoneIds.forEach((id, i) => {
    const polygon = zonePolygon(id);
    if (!polygon.length) return;
    const active = status?.activeZones.some(zone => zone === id) ||
      status?.activeToolContacts.some(({ a, b }) => a === id || b === id);
    tracePolygon(polygon, w, h);
    ctx.strokeStyle = colors[i]!;
    ctx.fillStyle = `${colors[i]}${active ? "44" : "14"}`;
    ctx.lineWidth = selectedZone === id ? 4 : 2;
    ctx.fill(); ctx.stroke();
  });
  lastResults?.landmarks.forEach((hand, index) => {
    ctx.strokeStyle = index === 0 ? "#8cf4c8" : "#c5acff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 2;
    const chains = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12], [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17]];
    for (const chain of chains) {
      ctx.beginPath();
      chain.forEach((n, i) => { const p = hand[n]!; if (i === 0) ctx.moveTo(p.x * w, p.y * h); else ctx.lineTo(p.x * w, p.y * h); });
      ctx.stroke();
    }
    hand.forEach((p, n) => { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, [4, 8, 12, 16, 20].includes(n) ? 5 : 3, 0, Math.PI * 2); ctx.fill(); });
  });
  // Jaw ends: the only points tested for tip tool contacts.
  jawPoints?.forEach(([x, y]) => {
    ctx.beginPath(); ctx.arc(x * w, y * h, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.strokeStyle = colors[1]!; ctx.lineWidth = 3; ctx.stroke();
  });
  if (markerEnabled.checked) drawMarkerBoxes(ctx, markers, mirror.checked);
  if (calibration) {
    // The frozen marker pose that this face's drawing is measured against.
    tracePolygon(calibration.corners, w, h);
    ctx.setLineDash([5, 4]); ctx.strokeStyle = "#ffdc70"; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
    for (const part of ["tongs-tip", "tongs-handle"] as const) {
      const polygon = calibration.parts[part];
      if (!polygon) continue;
      tracePolygon(polygon, w, h);
      ctx.strokeStyle = colors[zoneIds.indexOf(part)]!; ctx.fillStyle = `${colors[zoneIds.indexOf(part)]}33`; ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
    }
  }
  const first = draft[0], last = draft[draft.length - 1];
  if (first && last && calibration?.step === "jaws") {
    draft.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x * w, y * h, 6, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill(); });
  } else if (first && last) {
    const closing = canClose();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
    ctx.beginPath();
    draft.forEach(([x, y], n) => n === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h));
    ctx.stroke();
    if (cursor) {
      // Rubber-band edge from the last corner to the pointer, snapping to the first corner when it would close.
      const [x, y] = closing ? first : cursor;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(last[0] * w, last[1] * h); ctx.lineTo(x * w, y * h); ctx.stroke();
      ctx.setLineDash([]);
    }
    draft.forEach(([x, y], n) => {
      ctx.beginPath();
      ctx.arc(x * w, y * h, n === 0 && closing ? 8 : 4, 0, Math.PI * 2);
      ctx.fillStyle = n === 0 ? draftColor() : "#ffffff";
      ctx.fill();
    });
  }
}

/** Distance between two raw normalized points in on-screen CSS pixels (mirroring doesn't change it). */
function screenDistance(a: Point, b: Point): number {
  const bounds = canvas.getBoundingClientRect();
  return Math.hypot((a[0] - b[0]) * bounds.width, (a[1] - b[1]) * bounds.height);
}

function canClose(): boolean {
  return calibration?.step !== "jaws" && draft.length >= 3 && !!cursor && screenDistance(cursor, draft[0]!) <= CLOSE_RADIUS_PX;
}

function updateStatus(next: VisionStatus) {
  status = next;
  el("hands").textContent = String(next.handsVisible);
  el("fps").textContent = String(next.fps);
  el("landmarks").textContent = `${next.handsVisible * 21} points`;
  el("active").textContent = [
    ...next.activeZones.map(id => SURFACES[id].label),
    ...next.activeToolContacts.map(({ a, b }) => `${SURFACES[a].label} → ${SURFACES[b].label}`),
  ].join(", ") || "None";
  el<HTMLProgressElement>("wash").value = next.washProgress;
  el("wash-text").textContent = `${Math.round(next.washProgress * 100)}%`;
  el("tong-tracking").textContent = running ? TRACKING_LABELS[next.utensils.tongs.tracking] : "—";
  el("tong-tracking").classList.toggle("warn", running && next.utensils.tongs.tracking === "lost");
  enginePanel.setTracking(running ? next.utensils.tongs.tracking : null);
}

function logEvent(event: ContactEvent | WashEvent) {
  events.push(event);
  if (events.length > 500) events.shift();
  const row = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  const label = document.createElement("span");
  label.textContent = event.kind === "contact"
    ? `${event.a === "hands" ? "Hands" : SURFACES[event.a].label} → ${SURFACES[event.b].label}`
    : "Wash zone dwell completed · unverified";
  const detail = document.createElement("span");
  detail.className = "event-detail";
  detail.textContent = event.kind === "contact"
    ? `${Math.round(event.confidence * 100)}% ${event.a === "hands" ? "overlap" : "tracked"} frames`
    : `${((event.durationMs ?? 0) / 1000).toFixed(1)}s in zone`;
  row.append(time, label, detail);
  el("events").prepend(row);
  while (el("events").children.length > 30) el("events").lastElementChild?.remove();
  el("event-count").textContent = String(events.length);
  el("events-empty").hidden = true;
  el<HTMLButtonElement>("export").disabled = false;
  enginePanel.onVisionEvent(event);
  // Integration point for a dashboard/engine without coupling the camera UI to it.
  window.dispatchEvent(new CustomEvent("ghosttrace:vision-event", { detail: event }));
}

function onMarkers(next: DetectedMarker[], frame: { width: number; height: number; ms: number }) {
  markers = next;
  // Side length is what decides whether a tag is big enough (§4.4: ≥ 30 px).
  el("marker-status").textContent = next.length ? next.map(m => {
    const side = Math.round(markerSidePx(m, frame.width, frame.height));
    return `${m.id} · ${side} px${side < MIN_MARKER_SIDE_PX ? " ⚠" : ""}`;
  }).join(", ") : "No markers visible";
  el("marker-frame").textContent = `${frame.width} × ${frame.height} · ${Math.round(frame.ms)} MS`;
  if (trial) { recordMarkerFrame(trial, next, frame); renderTrials(); }
}

function stopCamera(text = "Camera stopped. Start it again whenever you’re ready.") {
  generation++;
  running = false;
  vision?.stop(); vision = undefined;
  markers = []; jawPoints = null;
  endCalibration();
  endTrial();
  el("marker-status").textContent = "Camera offline";
  el("marker-frame").textContent = "—";
  stream?.getTracks().forEach(track => track.stop()); stream = undefined;
  video.srcObject = null;
  lastResults = undefined;
  draft = []; cursor = undefined;
  updateStatus({ t: performance.now(), handsVisible: 0, activeZones: [], washProgress: 0, fps: 0,
    activeToolContacts: [], utensils: fixedUtensilStatus(zones) });
  draw();
  el("empty").hidden = false;
  el("badge").textContent = "● Camera offline";
  el("badge").classList.remove("live");
  el("model-state").textContent = "Not loaded";
  el("resolution").textContent = "AWAITING CAMERA";
  start.disabled = false; stop.disabled = true; camera.disabled = false;
  renderCalibration();
  message(text);
}

async function startCamera() {
  const attempt = ++generation;
  start.disabled = true; stop.disabled = false; camera.disabled = true;
  message("Requesting camera access…");
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires localhost or HTTPS. Open the app using the Vite URL.");
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
        ...(camera.value ? { deviceId: { exact: camera.value } } : { facingMode: "environment" }) },
    });
    if (attempt !== generation) { nextStream.getTracks().forEach(track => track.stop()); return; }
    stream = nextStream;
    video.srcObject = stream;
    await video.play();
    if (attempt !== generation) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    el("stage").style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    el("empty").hidden = true;
    el("resolution").textContent = `${canvas.width} × ${canvas.height} / RAW`;
    el("model-state").textContent = "Loading…";
    el("marker-status").textContent = "Starting…";
    message("Camera connected. Downloading the hand-tracking model — the first start may take a moment…");
    draw();
    const handle = await startVision({ video, zones, utensilModels, onEvent: logEvent,
      onStatus: next => { updateStatus(next); draw(); },
      onResults: result => { lastResults = result; },
      onMarkers,
      onJawPoints: points => { jawPoints = points; },
      onError: error => { stopCamera(); message(`Tracking stopped: ${error instanceof Error ? error.message : String(error)}. Try starting again.`, true); },
    });
    if (attempt !== generation) { handle.stop(); return; }
    vision = handle;
    running = true;
    renderTrials();
    renderCalibration();
    el("model-state").textContent = "MediaPipe · ready";
    el("badge").textContent = "● Tracking live";
    el("badge").classList.add("live");
    camera.disabled = false;
    message("Tracking live. Hold your hands in view, or select a zone to calibrate it.");
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (attempt === generation) stopCamera("Camera disconnected. Reconnect it and start again.");
    });
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (attempt !== generation) return;
      const selected = stream?.getVideoTracks()[0]?.getSettings().deviceId;
      camera.replaceChildren(...devices.filter(d => d.kind === "videoinput").map((device, i) => new Option(device.label || `Camera ${i + 1}`, device.deviceId)));
      if (selected) camera.value = selected;
    } catch { /* Camera discovery is optional once the stream is running. */ }
  } catch (error) {
    if (attempt !== generation) return;
    stopCamera();
    const name = error instanceof Error ? error.name : "";
    const explanation = name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser, then try again."
      : name === "NotFoundError" ? "No camera found. Connect a webcam and try again."
      : name === "NotReadableError" ? "The camera is busy or unavailable. Close other camera apps and try again."
      : name === "OverconstrainedError" ? "That camera is unavailable. Select another camera and try again."
      : `Could not start tracking: ${error instanceof Error ? error.message : String(error)}. Check your internet connection for the model download.`;
    message(explanation, true);
  }
}

function saveZones() {
  vision?.setZones(zones);
  try { localStorage.setItem(ZONE_LAYOUT_STORAGE_KEY, JSON.stringify(zones)); }
  catch { el("zone-help").textContent = "Browser storage is unavailable. These zones will last for this session only."; }
  const overlapping = new Set(overlappingZones(zones).flat());
  document.querySelectorAll<HTMLButtonElement>("[data-zone]").forEach(button => {
    const id = button.dataset.zone as ZonedObjectId;
    const state = button.querySelector(".zone-state")!;
    state.textContent = !zones[id].length ? "Unset" : overlapping.has(id) ? "Overlaps" : "Set";
    state.classList.toggle("warn", overlapping.has(id));
    button.setAttribute("aria-pressed", String(id === selectedZone));
  });
  el("zone-count").textContent = `${zoneIds.filter(id => zones[id].length).length} / 5`;
  draw();
}

function pointer(event: PointerEvent): Point {
  const bounds = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  return [mirror.checked ? 1 - x : x, Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))];
}
/** Switching zones (or deselecting) always discards an unfinished outline, and any tong calibration. */
function selectZone(next: ZonedObjectId | undefined) {
  if (next) endCalibration();
  selectedZone = next;
  draft = []; cursor = undefined;
  canvas.classList.toggle("calibrating", !!next || !!calibration);
  saveZones();
  el("zone-help").textContent = next ? `Outline ${SURFACES[next].label}. ${DRAW_HELP}` : IDLE_HELP;
}

function finishDraft() {
  if (calibration) { finishCalibrationStep(); return; }
  if (!selectedZone) return;
  const error = validatePolygon(draft);
  if (error) { el("zone-help").textContent = error; return; }
  const id = selectedZone;
  zones[id] = draft;
  selectZone(undefined);
  const others = overlappingZones(zones).flatMap(([a, b]) => a === id ? [b] : b === id ? [a] : []);
  el("zone-help").textContent = others.length ? overlapWarning(id, others)
    : `${SURFACES[id].label} saved. Select another surface to outline it.`;
}

/** Saved anyway (the tracker can cope), but the person calibrating should know why it's risky. */
function overlapWarning(id: ZonedObjectId, others: ZonedObjectId[]): string {
  const isTongPair = (other: ZonedObjectId) => SURFACES[id].utensilId !== undefined && SURFACES[id].utensilId === SURFACES[other].utensilId;
  const reasons = [
    others.some(isTongPair) && "Leave a gap over the hinge so tip and handle touches can't be confused.",
    others.some(other => !isTongPair(other)) && "A touch in the shared area counts for both zones.",
  ].filter(Boolean).join(" ");
  return `⚠ ${SURFACES[id].label} saved, but it overlaps ${others.map(other => SURFACES[other].label).join(", ")}. ${reasons}`;
}

function renderCalibration() {
  const calibrated = new Set(utensilModels.tongs?.markers.map(m => m.markerId));
  el("calibrated-faces").textContent = TONG_MARKER_IDS.map(id => `${id} ${calibrated.has(id) ? "✓" : "—"}`).join(" · ");
  document.querySelectorAll<HTMLButtonElement>("[data-calibrate]").forEach(button => {
    button.disabled = !running;
    button.setAttribute("aria-pressed", String(calibration?.markerId === Number(button.dataset.calibrate)));
  });
  el<HTMLButtonElement>("clear-calibration").disabled = !calibrated.size;
  if (!calibration) el("calibration-help").textContent = CALIBRATION_IDLE_HELP;
}

function startCalibration(markerId: number) {
  // Freeze the tag as it is now: the outlines are measured against this one pose.
  const marker = markers.find(m => m.id === markerId);
  if (!running || !marker) {
    el("calibration-help").textContent = `ID ${markerId} isn't in view. Lay the tongs flat and closed with ID ${markerId} face up, then try again.`;
    return;
  }
  selectZone(undefined);
  calibration = { markerId, corners: marker.corners, step: "tongs-tip", parts: {} };
  draft = []; cursor = undefined;
  canvas.classList.add("calibrating");
  el("calibration-help").textContent = `ID ${markerId}: ${CALIBRATION_STEPS["tongs-tip"]}`;
  renderCalibration();
  draw();
}

function endCalibration(text?: string) {
  if (!calibration) return;
  calibration = undefined;
  draft = []; cursor = undefined;
  canvas.classList.toggle("calibrating", !!selectedZone);
  renderCalibration();
  if (text) el("calibration-help").textContent = text;
  draw();
}

function finishCalibrationStep() {
  const c = calibration!;
  if (c.step !== "jaws") {
    const error = validatePolygon(draft);
    if (error) { el("calibration-help").textContent = error; return; }
    c.parts[c.step] = draft;
    draft = [];
    c.step = c.step === "tongs-tip" ? "tongs-handle" : "jaws";
    const tip = c.parts["tongs-tip"], handle = c.parts["tongs-handle"];
    const hinge = tip && handle && polygonsOverlap(tip, handle) ? "⚠ Tip and handle overlap: a gap over the hinge keeps their touches apart. " : "";
    el("calibration-help").textContent = `ID ${c.markerId}: ${hinge}${CALIBRATION_STEPS[c.step]}`;
    draw();
    return;
  }
  const tip = c.parts["tongs-tip"], handle = c.parts["tongs-handle"];
  if (!draft.length) { el("calibration-help").textContent = `ID ${c.markerId}: click at least one jaw end first.`; return; }
  if (!tip || !handle) return;
  const entry = calibrateMarker(c.markerId, c.corners, { "tongs-tip": tip, "tongs-handle": handle }, draft);
  if (!entry) { endCalibration(`ID ${c.markerId}: the marker outline was too distorted to calibrate. Lay the tongs flat and try again.`); return; }
  utensilModels = { tongs: { markers: [...(utensilModels.tongs?.markers ?? []).filter(m => m.markerId !== c.markerId), entry] } };
  saveUtensilModels();
  const missing = TONG_MARKER_IDS.filter(id => !utensilModels.tongs?.markers.some(m => m.markerId === id));
  endCalibration(`ID ${c.markerId} calibrated.${missing.length ? ` Flip the tongs and calibrate ID ${missing.join(", ")}.` : " Both faces are calibrated."}`);
}

function saveUtensilModels() {
  vision?.setUtensilModels(utensilModels);
  try {
    if (utensilModels.tongs) localStorage.setItem(UTENSIL_MODELS_STORAGE_KEY, JSON.stringify(utensilModels));
    else localStorage.removeItem(UTENSIL_MODELS_STORAGE_KEY);
  } catch { el("calibration-help").textContent = "Browser storage is unavailable. This calibration will last for this session only."; }
  renderCalibration();
}

canvas.addEventListener("pointerdown", event => {
  if ((!selectedZone && !calibration) || !stream) return;
  cursor = pointer(event);
  const last = draft[draft.length - 1];
  if (calibration?.step === "jaws") {
    if (last && screenDistance(cursor, last) < MIN_VERTEX_GAP_PX) return;
    draft.push(cursor);
    if (draft.length === 2) finishDraft(); // at most two jaw ends
    draw();
    return;
  }
  if (canClose()) { finishDraft(); return; }
  if (last && screenDistance(cursor, last) < MIN_VERTEX_GAP_PX) return;
  draft.push(cursor);
  draw();
});
canvas.addEventListener("pointermove", event => { if ((selectedZone || calibration) && draft.length) { cursor = pointer(event); draw(); } });
canvas.addEventListener("pointerleave", () => { cursor = undefined; draw(); });
window.addEventListener("keydown", event => {
  if ((!selectedZone && !calibration) || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === "Enter") finishDraft();
  else if (event.key === "Backspace" && draft.length) draft.pop();
  else if (event.key === "Escape") { if (calibration) endCalibration("Calibration cancelled. Nothing was saved."); else selectZone(undefined); }
  else return;
  event.preventDefault(); // stops Enter from also "clicking" the focused zone button
  draw();
});
document.querySelectorAll<HTMLButtonElement>("[data-zone]").forEach(button => button.addEventListener("click", () => {
  selectZone(selectedZone === button.dataset.zone ? undefined : button.dataset.zone as ZonedObjectId);
}));
document.querySelectorAll<HTMLButtonElement>("[data-calibrate]").forEach(button => button.addEventListener("click", () => {
  const id = Number(button.dataset.calibrate);
  if (calibration?.markerId === id) endCalibration("Calibration cancelled. Nothing was saved.");
  else { endCalibration(); startCalibration(id); }
}));
el("clear-calibration").addEventListener("click", () => {
  endCalibration();
  utensilModels = {};
  saveUtensilModels();
  el("calibration-help").textContent = "Calibration cleared. The tongs use their fixed zones until a face is calibrated.";
});
el("presets").addEventListener("click", () => {
  zoneIds.forEach((id, i) => { const x = 0.035 + i * 0.195; zones[id] = [[x, 0.6], [x + 0.15, 0.6], [x + 0.15, 0.93], [x, 0.93]]; });
  saveZones(); el("zone-help").textContent = "Demo zones placed along the bottom of the frame. These are placeholders; calibrate them to match your surfaces.";
});
el("clear-zones").addEventListener("click", () => { zones = emptyZones(); saveZones(); });
start.addEventListener("click", () => void startCamera());
stop.addEventListener("click", () => stopCamera());
camera.addEventListener("change", () => { if (running) { stopCamera(); void startCamera(); } });
mirror.addEventListener("change", () => el("feed").classList.toggle("mirrored", mirror.checked));
mirror.addEventListener("change", draw);
markerEnabled.addEventListener("change", draw);

const percent = (part: number, whole: number) => whole ? Math.round(100 * part / whole) : 0;

function trialRow(t: MarkerTrial, n: number, recording: boolean) {
  const row = document.createElement("li");
  const faces = TONG_MARKER_IDS.filter(id => t.framesById[id]).join(" + ") || "none";
  row.textContent = `${recording ? "● Recording" : `#${n}`} · ${t.detected}/${t.frames} frames (${percent(t.detected, t.frames)}%) · ID ${faces}`
    + (t.minSidePx === null ? "" : ` · min ${Math.round(t.minSidePx)} px`);
  row.classList.toggle("warn", !recording && t.detected < GO_NO_GO_RATE * t.frames);
  return row;
}

function renderTrials() {
  const toggle = el<HTMLButtonElement>("trial-toggle");
  toggle.textContent = trial ? "End trial (T)" : "Start trial (T)";
  toggle.disabled = !trial && !running;
  el<HTMLButtonElement>("trial-clear").disabled = !trials.length || !!trial;
  el("trial-list").replaceChildren(...[...trials.map((t, i) => trialRow(t, i + 1, false)), ...trial ? [trialRow(trial, 0, true)] : []].reverse());
  const frames = trials.reduce((sum, t) => sum + t.frames, 0);
  const detected = trials.reduce((sum, t) => sum + t.detected, 0);
  const passed = trials.filter(t => t.detected >= GO_NO_GO_RATE * t.frames).length;
  el("trial-summary").textContent = !trials.length ? "No trials yet"
    : `${passed}/${trials.length} passed · ${percent(detected, frames)}% of ${frames} frames`;
}

/** Also refreshes the trial controls, so call it whenever detection starts or stops. */
function endTrial() {
  if (trial?.frames) trials.push(trial);
  trial = undefined;
  renderTrials();
}

function toggleTrial() {
  if (trial) endTrial();
  else if (running) { trial = createMarkerTrial(); renderTrials(); }
}

el("download-marker").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([createMarkerSvg()], { type: "image/svg+xml" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "aruco-4x4_50-id-0.svg"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
el("print-markers").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([createTongMarkerSheet()], { type: "text/html" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
el("trial-toggle").addEventListener("click", toggleTrial);
el("trial-clear").addEventListener("click", () => { trials.length = 0; renderTrials(); });
window.addEventListener("keydown", event => {
  if (event.key !== "t" && event.key !== "T") return;
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  toggleTrial();
});
el("clear-events").addEventListener("click", () => {
  events.length = 0; el("events").replaceChildren(); el("event-count").textContent = "0";
  el("events-empty").hidden = false; el<HTMLButtonElement>("export").disabled = true;
});
el("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ zones, utensilModels, events }, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "ghosttrace-vision.json"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("pagehide", () => stopCamera());
saveZones();
renderCalibration();
