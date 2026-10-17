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

## Integrate with the engine

`src/vision/index.ts` exports `startVision`, compatible with `StartVision` from `src/shared/vision-types.ts`. Supply a playing raw video element, calibrated zones, `onEvent`, and `onStatus`. The handle supports `stop()` and `setZones()`. The UI also emits a `ghosttrace:vision-event` CustomEvent on window for each shared contact/wash event:

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
