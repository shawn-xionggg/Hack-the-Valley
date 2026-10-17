// Camera + startVision for the dashboard. Zones and tong models are calibrated on the vision dev page
// (index.html) and read here from localStorage; recalibrating in another tab updates a running camera.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { DEFAULT_TUNING, UTENSIL_MODELS_STORAGE_KEY, ZONE_LAYOUT_STORAGE_KEY } from "../shared/config";
import type { Point, UtensilModels, ZoneLayout } from "../shared/config";
import type { ContactEvent, VisionStatus, WashEvent } from "../shared/events";
import type { VisionHandle } from "../shared/vision-types";
import { startVision } from "../vision";
import { parseZoneLayout } from "../vision/geometry";
import { parseUtensilModels } from "../vision/pose";

export type CameraPhase = "off" | "starting" | "live";

/** Everything the camera view draws for one processed frame. */
export interface VisionFrame {
  status: VisionStatus;
  /** Fingertips of every detected hand, raw normalized coordinates. */
  fingertips: Point[];
  /** Jaw ends of the current tong pose; null unless tracked or held. */
  jawPoints: Point[] | null;
}

export interface LiveVision {
  videoRef: RefObject<HTMLVideoElement | null>;
  phase: CameraPhase;
  message: { text: string; error: boolean };
  frame: VisionFrame | null;
  /** Raw camera size once playing, for the overlay's coordinate space. */
  size: { width: number; height: number } | null;
  zones: ZoneLayout;
  utensilModels: UtensilModels;
  cameras: MediaDeviceInfo[];
  start(deviceId?: string): void;
  stop(): void;
}

const EMPTY_ZONES: ZoneLayout = { "peanut-source": [], "tongs-tip": [], "tongs-handle": [], "meal-1": [], "wash-station": [] };

function readStored<T>(key: string, parse: (value: unknown) => T): T | null {
  try { return parse(JSON.parse(localStorage.getItem(key) ?? "null")); }
  catch { return null; }
}
const loadZones = () => readStored(ZONE_LAYOUT_STORAGE_KEY, parseZoneLayout) ?? EMPTY_ZONES;
const loadModels = () => readStored(UTENSIL_MODELS_STORAGE_KEY, parseUtensilModels) ?? {};

function explain(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser, then try again."
    : name === "NotFoundError" ? "No camera found. Connect a webcam and try again."
    : name === "NotReadableError" ? "The camera is busy or unavailable. Close other camera apps (including the vision page) and try again."
    : name === "OverconstrainedError" ? "That camera is unavailable. Select another camera and try again."
    : `Could not start tracking: ${error instanceof Error ? error.message : String(error)}. Check your internet connection for the model download.`;
}

export function useLiveVision(onEvent: (event: ContactEvent | WashEvent) => void): LiveVision {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<CameraPhase>("off");
  const [message, setMessage] = useState({ text: "Camera off. Start it to track contacts live, or replay a simulated act.", error: false });
  const [frame, setFrame] = useState<VisionFrame | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [zones, setZones] = useState(loadZones);
  const [utensilModels, setUtensilModels] = useState(loadModels);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const session = useRef<{ stream?: MediaStream; vision?: VisionHandle }>({});
  /** Bumped on every start and stop, so a slow start that was superseded cleans up after itself. */
  const generation = useRef(0);
  const zonesRef = useRef(zones);
  const modelsRef = useRef(utensilModels);

  const stop = useCallback((text = "Camera stopped.", error = false) => {
    generation.current++;
    session.current.vision?.stop();
    session.current.stream?.getTracks().forEach(track => track.stop());
    session.current = {};
    if (videoRef.current) videoRef.current.srcObject = null;
    setPhase("off");
    setFrame(null);
    setMessage({ text, error });
  }, []);

  const start = useCallback((deviceId?: string) => {
    const attempt = ++generation.current;
    session.current.vision?.stop();
    session.current.stream?.getTracks().forEach(track => track.stop());
    session.current = {};
    setPhase("starting");
    setMessage({ text: "Requesting camera access…", error: false });
    void (async () => {
      try {
        const video = videoRef.current;
        if (!video) throw new Error("The video element isn't mounted.");
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera access requires localhost or HTTPS. Open the app using the Vite URL.");
        }
        // 1280×720 at native resolution: tong markers must stay ≥ 30 px per side (§4.4).
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
            ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" }) },
        });
        if (attempt !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
        session.current.stream = stream;
        video.srcObject = stream;
        await video.play();
        if (attempt !== generation.current) return;
        setSize({ width: video.videoWidth, height: video.videoHeight });
        setMessage({ text: "Camera connected. Loading the hand-tracking model — the first start may take a moment…", error: false });
        let fingertips: Point[] = [];
        let jawPoints: Point[] | null = null;
        const handle = await startVision({
          video,
          zones: zonesRef.current,
          utensilModels: modelsRef.current,
          onEvent: event => onEventRef.current(event),
          onResults: result => {
            fingertips = result.landmarks.flatMap(hand =>
              DEFAULT_TUNING.fingertipLandmarks.flatMap(n => { const p = hand[n]; return p ? [[p.x, p.y] as Point] : []; }));
          },
          onJawPoints: points => { jawPoints = points; },
          // One React update per processed frame (≤ 20 fps); onResults and onJawPoints run just before this.
          onStatus: status => { if (attempt === generation.current) setFrame({ status, fingertips, jawPoints }); },
          onError: error => {
            if (attempt === generation.current) stop(`Tracking stopped: ${error instanceof Error ? error.message : String(error)}. Try starting again.`, true);
          },
        });
        if (attempt !== generation.current) { handle.stop(); return; }
        session.current.vision = handle;
        setPhase("live");
        setMessage({ text: "Tracking live.", error: false });
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (attempt === generation.current) stop("Camera disconnected. Reconnect it and start again.", true);
        });
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (attempt === generation.current) setCameras(devices.filter(d => d.kind === "videoinput"));
        } catch { /* Camera discovery is optional once the stream is running. */ }
      } catch (error) {
        if (attempt === generation.current) stop(explain(error), true);
      }
    })();
  }, [stop]);

  // Recalibration on the vision page (another tab, same origin) reaches us as a storage event.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ZONE_LAYOUT_STORAGE_KEY) {
        const next = loadZones();
        zonesRef.current = next;
        setZones(next);
        session.current.vision?.setZones(next);
      } else if (event.key === UTENSIL_MODELS_STORAGE_KEY) {
        const next = loadModels();
        modelsRef.current = next;
        setUtensilModels(next);
        session.current.vision?.setUtensilModels(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const onHide = () => stop();
    window.addEventListener("pagehide", onHide);
    return () => { window.removeEventListener("pagehide", onHide); stop(); };
  }, [stop]);

  return { videoRef, phase, message, frame, size, zones, utensilModels, cameras, start, stop };
}
