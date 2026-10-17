import "./style.css";
import { SURFACES, ZONE_LAYOUT_STORAGE_KEY } from "./shared/config";
import type { Point, ZoneLayout, ZonedObjectId } from "./shared/config";
import type { ContactEvent, VisionStatus, WashEvent } from "./shared/events";
import type { VisionHandle } from "./shared/vision-types";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { startVision } from "./vision";
import { overlappingZones, validatePolygon } from "./vision/geometry";
import { fixedUtensilStatus } from "./vision/tracker";

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
        <section class="panel zones-panel"><div class="panel-heading"><h2>Contact zones</h2><span class="mono" id="zone-count">0 / 5</span></div>
          <p class="hint zone-intro">Select a surface, then click its corners on the camera to outline its area.</p>
          <div id="zone-list" class="zone-list">${zoneIds.map((id, i) => `<button class="zone-button" data-zone="${id}" aria-pressed="false"><span class="zone-dot" style="background:${colors[i]}"></span><span>${SURFACES[id].label}</span><span class="zone-state">Unset</span></button>`).join("")}</div>
          <div class="zone-actions"><button class="text-button" id="presets">Use demo layout</button><button class="text-button" id="clear-zones">Clear zones</button></div>
          <p class="hint" id="zone-help">Zones are saved on this device. Recalibrate after moving the camera or switching cameras.</p>
        </section>
      </aside>
    </div>
    <section class="panel events-panel"><div class="panel-heading"><h2>Activity <span id="event-count" class="count">0</span></h2><div><button class="text-button" id="export" disabled>Export JSON</button><button class="text-button" id="clear-events">Clear log</button></div></div>
      <div class="events-empty" id="events-empty">No contacts yet. Calibrate a zone and hold a fingertip inside it for 0.4 seconds.</div><ol id="events" class="events" aria-live="polite" aria-label="Recent contact and wash events"></ol>
    </section>
    <footer><span><span class="small-dot"></span> Local inference · No video uploads</span><span>Zone overlap estimates contact. Wash events are unverified.</span></footer>
  </main>`;

function el<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const video = el<HTMLVideoElement>("video");
const canvas = el<HTMLCanvasElement>("overlay");
const ctx = canvas.getContext("2d")!;
const start = el<HTMLButtonElement>("start");
const stop = el<HTMLButtonElement>("stop");
const camera = el<HTMLSelectElement>("camera");
const mirror = el<HTMLInputElement>("mirror");
let stream: MediaStream | undefined;
let vision: VisionHandle | undefined;
let generation = 0;
let running = false;
let selectedZone: ZonedObjectId | undefined;
/** Vertices placed so far for the selected zone, in raw normalized coordinates. */
let draft: Point[] = [];
let cursor: Point | undefined;
const CLOSE_RADIUS_PX = 12; // clicking this close to the first vertex closes the polygon
const MIN_VERTEX_GAP_PX = 6; // clicks this close to the previous vertex are ignored (double-clicks)
const DRAW_HELP = "Click to place corners. Click the first corner or press Enter to finish · Backspace undoes · Esc cancels.";
const IDLE_HELP = "Zones are saved on this device. Recalibrate after moving the camera or switching cameras.";
let lastResults: HandLandmarkerResult | undefined;
let status: VisionStatus | undefined;
const events: (ContactEvent | WashEvent)[] = [];

function message(text: string, error = false) {
  el("message").textContent = text;
  el("message").classList.toggle("error", error);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height;
  zoneIds.forEach((id, i) => {
    const polygon = zones[id];
    if (!polygon.length) return;
    ctx.beginPath();
    polygon.forEach(([x, y], n) => n === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h));
    ctx.closePath();
    ctx.strokeStyle = colors[i]!;
    ctx.fillStyle = `${colors[i]}${status?.activeZones.some(active => active === id) ? "44" : "14"}`;
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
  const first = draft[0], last = draft[draft.length - 1];
  if (first && last) {
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
      ctx.fillStyle = n === 0 ? colors[zoneIds.indexOf(selectedZone!)] ?? "#ffffff" : "#ffffff";
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
  return draft.length >= 3 && !!cursor && screenDistance(cursor, draft[0]!) <= CLOSE_RADIUS_PX;
}

function updateStatus(next: VisionStatus) {
  status = next;
  el("hands").textContent = String(next.handsVisible);
  el("fps").textContent = String(next.fps);
  el("landmarks").textContent = `${next.handsVisible * 21} points`;
  el("active").textContent = next.activeZones.map(id => SURFACES[id].label).join(", ") || "None";
  el<HTMLProgressElement>("wash").value = next.washProgress;
  el("wash-text").textContent = `${Math.round(next.washProgress * 100)}%`;
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
  detail.textContent = event.kind === "contact" ? `${Math.round(event.confidence * 100)}% overlap frames` : `${((event.durationMs ?? 0) / 1000).toFixed(1)}s in zone`;
  row.append(time, label, detail);
  el("events").prepend(row);
  while (el("events").children.length > 30) el("events").lastElementChild?.remove();
  el("event-count").textContent = String(events.length);
  el("events-empty").hidden = true;
  el<HTMLButtonElement>("export").disabled = false;
  // Integration point for a dashboard/engine without coupling the camera UI to it.
  window.dispatchEvent(new CustomEvent("ghosttrace:vision-event", { detail: event }));
}

function stopCamera(text = "Camera stopped. Start it again whenever you’re ready.") {
  generation++;
  running = false;
  vision?.stop(); vision = undefined;
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
    message("Camera connected. Downloading the hand-tracking model — the first start may take a moment…");
    draw();
    const handle = await startVision({ video, zones, onEvent: logEvent,
      onStatus: updateStatus,
      onResults: result => { lastResults = result; draw(); },
      onError: error => { stopCamera(); message(`Tracking stopped: ${error instanceof Error ? error.message : String(error)}. Try starting again.`, true); },
    });
    if (attempt !== generation) { handle.stop(); return; }
    vision = handle;
    running = true;
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
/** Switching zones (or deselecting) always discards an unfinished outline. */
function selectZone(next: ZonedObjectId | undefined) {
  selectedZone = next;
  draft = []; cursor = undefined;
  canvas.classList.toggle("calibrating", !!next);
  saveZones();
  el("zone-help").textContent = next ? `Outline ${SURFACES[next].label}. ${DRAW_HELP}` : IDLE_HELP;
}

function finishDraft() {
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

canvas.addEventListener("pointerdown", event => {
  if (!selectedZone || !stream) return;
  cursor = pointer(event);
  if (canClose()) { finishDraft(); return; }
  const last = draft[draft.length - 1];
  if (last && screenDistance(cursor, last) < MIN_VERTEX_GAP_PX) return;
  draft.push(cursor);
  draw();
});
canvas.addEventListener("pointermove", event => { if (selectedZone && draft.length) { cursor = pointer(event); draw(); } });
canvas.addEventListener("pointerleave", () => { cursor = undefined; draw(); });
window.addEventListener("keydown", event => {
  if (!selectedZone || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === "Enter") finishDraft();
  else if (event.key === "Backspace" && draft.length) draft.pop();
  else if (event.key === "Escape") selectZone(undefined);
  else return;
  event.preventDefault(); // stops Enter from also "clicking" the focused zone button
  draw();
});
document.querySelectorAll<HTMLButtonElement>("[data-zone]").forEach(button => button.addEventListener("click", () => {
  selectZone(selectedZone === button.dataset.zone ? undefined : button.dataset.zone as ZonedObjectId);
}));
el("presets").addEventListener("click", () => {
  zoneIds.forEach((id, i) => { const x = 0.035 + i * 0.195; zones[id] = [[x, 0.6], [x + 0.15, 0.6], [x + 0.15, 0.93], [x, 0.93]]; });
  saveZones(); el("zone-help").textContent = "Demo zones placed along the bottom of the frame. These are placeholders; calibrate them to match your surfaces.";
});
el("clear-zones").addEventListener("click", () => { zones = emptyZones(); saveZones(); });
start.addEventListener("click", () => void startCamera());
stop.addEventListener("click", () => stopCamera());
camera.addEventListener("change", () => { if (running) { stopCamera(); void startCamera(); } });
mirror.addEventListener("change", () => el("feed").classList.toggle("mirrored", mirror.checked));
el("clear-events").addEventListener("click", () => {
  events.length = 0; el("events").replaceChildren(); el("event-count").textContent = "0";
  el("events-empty").hidden = false; el<HTMLButtonElement>("export").disabled = true;
});
el("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ zones, events }, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "ghosttrace-vision.json"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("pagehide", () => stopCamera());
saveZones();
