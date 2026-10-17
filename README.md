# GhostTrace - camera frontend

Minimal TypeScript + Vite camera UI using MediaPipe Hand Landmarker. Tracks up to two hands and draws 21 landmarks per hand. Webcam frames go directly to the model in the browser. No video uploads, API key, or backend required.

## Run

Requires Node.js 22.12 or newer.

```powershell
cd C:\coding\hackathons\hackthevalley\Hack-the-Valley
npm.cmd install
npm.cmd run dev
```

Open the localhost URL printed by Vite, click **Start camera**, and allow camera access. Use Chrome or Edge. The first start needs internet to download the model and WASM runtime. Camera access needs localhost or HTTPS; opening index.html directly will not work.

- Choose a camera source, toggle mirroring if desired, and hold your hands in view.
- Select a contact zone, then click its corners on the feed; click the first corner or press Enter to finish (Backspace undoes a corner, Esc cancels). Zones that touch or overlap are flagged "Overlaps"; keep a gap between the tong tip and handle over the hinge. Coordinates are stored in the raw, unmirrored camera frame. Zones persist in localStorage. Recalibrate when moving or switching cameras.
- **Use demo layout** adds placeholder zones across the bottom of the feed; it does not detect objects or locate real surfaces.
- Hold a fingertip inside a contact zone for 400 ms to emit a contact; leave for 300 ms to rearm it. Hold a hand in the wash zone for 6 seconds to emit an unverified wash event.
- **Stop** releases the camera and closes the model. Camera and model failures appear below the preview.
- The log retains the latest 500 events and displays the latest 30. **Export JSON** downloads the retained events and calibrated zones.

## Tong markers

The tongs carry two OpenCV **DICT_4X4_50** tags (spec A1 §4.4): ID 11 on arm A's outer face and ID 12 on arm B's, just behind the jaws. With **ArUco boxes** checked, yellow outlines and IDs follow visible tags; the small square marks each tag's corner 0.

Click **Print tong markers 11 + 12** to open a print sheet with the tong tags (spec §4.4) at 25 mm and 30 mm black-square size. Print it at 100% scale, then check that its scale bar measures 50 mm before cutting. **Download test marker #0** downloads a quick DICT_4X4_50 test tag; print it or show it on another screen. Keep the white margin visible and present the tag flat to the camera. Multiple markers and rotated tags are supported. Labels stay readable when mirroring the feed. Boxes clear when tags disappear or the camera stops.

The **Tong markers** panel shows each visible tag's side length in pixels, flagged with ⚠ below the 30 px minimum. It also shows the detection frame size and the time each detection takes.

### Night-one go/no-go (spec §4.6)

Mount both markers. Press **T** (or **Start trial**) as the dip starts, and press it again after the serve. Do 10 trials, 5 with each face up. Each trial records how many sampled frames showed ID 11 or 12, which faces were seen, and the smallest tag size. A trial passes at 80%, and the summary shows trials passed and the overall frame rate.

### Calibrate the tongs

Calibrate each face separately: the two outlines are mirror images.

1. Lay the tongs flat and closed with ID 11 face up, in view, and click **Calibrate ID 11**. The tag's current outline is frozen (dashed yellow), so keep the tongs still while you draw.
2. Outline the tips. Pad the outline past the jaws, because the lower jaw shifts in the image when the tongs open.
3. Outline the handle, leaving a gap over the hinge.
4. Click the jaw end (one or two points) and press **Enter**.
5. Flip the tongs and repeat with **Calibrate ID 12**.

Models are stored in marker-local coordinates under `ghosttrace.utensils.v2` and take effect immediately. **Clear calibration** returns the tongs to their fixed zones.

### Tracking

Once a face is calibrated, the tip and handle zones follow whichever calibrated tag is visible (the larger one if both are; the two are never averaged). **Tong tracking** shows the state:

- **Tracked:** a calibrated tag is visible this frame.
- **Held (last pose):** no tag for up to 500 ms, so the last pose is reused. Contacts still fire, but these frames don't count toward confidence.
- **Tong tracking lost — contacts not recorded:** no tag for longer than that. No contact of any kind involves the tongs.
- **Tongs: fixed position:** nothing is calibrated, so the static tip and handle zones are used and there are no tool contacts.

Tool contacts fire when a jaw end (white dot) comes within 0.6 tag widths (about 15 mm with a 25 mm tag) of the peanut or meal zone, or when the handle outline does. They use the same 400 ms dwell, exit and re-fire rules as hand contacts. The log shows them as, for example, **Tong tips → Peanut source** with the percentage of tracked frames.

`src/vision/aruco.ts` wraps [js-aruco2](https://github.com/damianofalcioni/js-aruco2). `startVision` detects tags on the same frame as the hands, at the camera's native resolution, because downscaling the 720p feed would halve tag size and double pose error. `src/vision/pose.ts` holds the homography, calibration and pose math, and `src/vision/tracker.ts` holds the tracking states and tool contacts.

## Integrate with the engine

`src/vision/index.ts` exports `startVision`, compatible with `StartVision` from `src/shared/vision-types.ts`. Supply a playing raw video element, calibrated zones, `onEvent`, and `onStatus`, plus `utensilModels` (from `parseUtensilModels` in `src/vision/pose.ts`, reading `ghosttrace.utensils.v2`) for moving tongs. The handle supports `stop()`, `setZones()` and `setUtensilModels()`. `VisionStatus.utensils.tongs` carries the tracking state and the current tip and handle polygons. The UI also emits a `ghosttrace:vision-event` CustomEvent on window for each shared contact/wash event:

```ts
window.addEventListener("ghosttrace:vision-event", event => {
  // engine.dispatch((event as CustomEvent).detail);
});
```

The vision module follows the [MediaPipe Web hand landmark API](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js). It tries GPU acceleration, then CPU, caps inference at 20 FPS, and skips duplicate video frames. Inference currently runs on the main thread; a worker is the next step if slower devices show UI lag. This frontend does not implement the exposure engine or a remote AI endpoint. Zone overlap estimates contact; it does not establish physical contact or detect allergens.

## Check

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run preview
```

### Rig trials

Click **Clear log**, run one set of attempts (for example 20 tong-tip touches, pausing at least 1.5 s between them), then click **Export JSON**. Tally one or more exports:

```sh
npm run tally -- --expect tongs-tip --attempts 20 trials/tip-1.json
```

`--expect` takes a contact zone, `wash`, or `none` (attempts that should produce no event, such as brushing past the wash station). Events less than `--gap` ms apart (default 1500) count as one attempt. The output is a Markdown table of correct, fired-twice, wrong-tong-part, unexpected and missed attempts, plus contact confidence. A held touch re-fires every second (spec v5 §4.4); those re-fires count as one touch, not as fired-twice.

Tests cover polygon containment, contact dwell and rearming, camera stalls, calibration changes, tong-zone ambiguity, and wash timing. A physical webcam check is still needed on the target laptop/browser.
