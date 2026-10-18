type CameraDevices = Pick<MediaDevices, "enumerateDevices" | "getUserMedia">;

/** Prefer the physical main rear lens over ultra-wide, telephoto, and combined cameras. */
export function selectBackCamera(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const back = devices.filter(device => device.kind === "videoinput" && device.deviceId &&
    /\b(back|rear|environment)\b/i.test(device.label));
  const physical = back.filter(device => !/ultra|0[.,]5\s*[x×]|telephoto|\btele\b|\bdual\b|\btriple\b/i.test(device.label));
  return physical.find(device => /\b(wide|main|primary)\b/i.test(device.label)) ?? physical[0] ?? back[0];
}

/** Acquire a fixed camera before attaching video or starting tracking. */
export async function openStableCamera(
  media: CameraDevices,
  deviceId?: string,
  isCurrent: () => boolean = () => true,
): Promise<MediaStream> {
  let owned: MediaStream | undefined;
  const stop = () => { owned?.getTracks().forEach(track => track.stop()); owned = undefined; };
  const check = () => {
    if (!isCurrent()) throw new DOMException("Camera start cancelled.", "AbortError");
  };
  const enumerate = async () => {
    try { return await media.enumerateDevices(); }
    catch { return []; } // Discovery failure must not block webcams or explicit camera choices.
  };
  const acquire = async (id?: string) => {
    owned = await media.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
        ...(id ? { deviceId: { exact: id } } : { facingMode: "environment" }),
      },
    });
    check();
    return owned;
  };
  try {
    check();
    // Honour a manual choice without opening any other camera first.
    if (deviceId) return await acquire(deviceId);
    const initial = await enumerate();
    check();
    const known = selectBackCamera(initial);
    if (known) return await acquire(known.deviceId);

    // Safari hides camera labels until permission is granted. Keep this temporary
    // stream off the preview; release it before opening the selected physical lens.
    const probe = await acquire();
    const devices = await enumerate();
    check();
    const selected = selectBackCamera(devices)?.deviceId ?? probe.getVideoTracks()[0]?.getSettings().deviceId;
    if (!selected) return probe; // Some browsers expose only an anonymous default webcam.
    stop();
    return await acquire(selected);
  } catch (error) {
    stop();
    throw error;
  }
}
