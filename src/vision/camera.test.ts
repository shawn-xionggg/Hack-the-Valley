import { describe, expect, it, vi } from "vitest";
import { openStableCamera, selectBackCamera } from "./camera";

const device = (deviceId: string, label: string, kind: MediaDeviceKind = "videoinput") =>
  ({ deviceId, label, kind, groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo;
const cameras = [
  device("front", "Front Camera"), device("ultra", "Back Ultra Wide Camera"),
  device("combined", "Back Triple Camera"), device("tele", "Back Telephoto Camera"),
  device("main", "Back Wide Camera"),
];
function stream(deviceId?: string) {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId }) };
  return { track, value: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
function rig(devices = cameras) {
  const active = stream("main");
  const media = {
    enumerateDevices: vi.fn(async () => devices),
    getUserMedia: vi.fn(async (_constraints: MediaStreamConstraints) => active.value),
  };
  return { media, active };
}

describe("stable camera acquisition", () => {
  it("prefers the physical wide rear lens over front, ultra-wide and combined cameras", async () => {
    const { media, active } = rig();
    expect(await openStableCamera(media)).toBe(active.value);
    expect(media.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: {
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, deviceId: { exact: "main" },
    } });
    expect(active.track.stop).not.toHaveBeenCalled();
  });

  it("recognizes rear/main labels and excludes audio devices and anonymous IDs", () => {
    expect(selectBackCamera([device("", "Back Wide Camera"), device("mic", "Back Wide Camera", "audioinput"),
      device("rear", "Rear Main Camera")])?.deviceId).toBe("rear");
    expect(selectBackCamera([device("front", "Front Camera")])).toBeUndefined();
    expect(selectBackCamera([device("ultra", "Back 0.5x Camera"), device("back", "Back Camera")])?.deviceId).toBe("back");
    expect(selectBackCamera([device("ultra", "Back Ultra Wide Camera")])?.deviceId).toBe("ultra");
  });

  it("opens only the manually selected camera without discovery or a rear-camera probe", async () => {
    const { media } = rig();
    await openStableCamera(media, "front");
    expect(media.enumerateDevices).not.toHaveBeenCalled();
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    expect(media.getUserMedia.mock.calls[0]?.[0].video).toMatchObject({ deviceId: { exact: "front" } });
  });

  it("unlocks labels with a temporary stream and stops it before opening the main lens", async () => {
    const { media, active } = rig();
    const probe = stream("ultra");
    media.enumerateDevices.mockResolvedValueOnce([device("", "")]);
    media.getUserMedia.mockResolvedValueOnce(probe.value).mockImplementationOnce(async () => {
      expect(probe.track.stop).toHaveBeenCalledOnce();
      return active.value;
    });
    expect(await openStableCamera(media)).toBe(active.value);
    expect(media.getUserMedia.mock.calls[0]?.[0].video).toMatchObject({ facingMode: "environment" });
    expect(media.getUserMedia.mock.calls[1]?.[0].video).toMatchObject({ deviceId: { exact: "main" } });
    expect(active.track.stop).not.toHaveBeenCalled();
  });

  it("locks the granted webcam ID when rear labels are unavailable or localized", async () => {
    const { media, active } = rig([device("webcam", "USB Webcam")]);
    const probe = stream("webcam");
    media.getUserMedia.mockResolvedValueOnce(probe.value);
    await openStableCamera(media);
    expect(probe.track.stop).toHaveBeenCalledOnce();
    expect(media.getUserMedia.mock.calls[1]?.[0].video).toMatchObject({ deviceId: { exact: "webcam" } });
    expect(active.track.stop).not.toHaveBeenCalled();
  });

  it("keeps a working anonymous webcam when IDs and enumeration are unavailable", async () => {
    const { media } = rig();
    const anonymous = stream();
    media.enumerateDevices.mockRejectedValue(new Error("Discovery unavailable"));
    media.getUserMedia.mockResolvedValueOnce(anonymous.value);
    expect(await openStableCamera(media)).toBe(anonymous.value);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    expect(anonymous.track.stop).not.toHaveBeenCalled();
  });

  it("propagates permission denial without retrying", async () => {
    const { media } = rig([]);
    const denied = new DOMException("Denied", "NotAllowedError");
    media.getUserMedia.mockRejectedValueOnce(denied);
    await expect(openStableCamera(media)).rejects.toBe(denied);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  });

  it("releases the permission stream and reports failure if the exact lens is unavailable", async () => {
    const { media } = rig([]);
    const probe = stream("main");
    const unavailable = new DOMException("Gone", "OverconstrainedError");
    media.getUserMedia.mockResolvedValueOnce(probe.value).mockRejectedValueOnce(unavailable);
    await expect(openStableCamera(media)).rejects.toBe(unavailable);
    expect(probe.track.stop).toHaveBeenCalledOnce();
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not request camera access when an attempt was already cancelled", async () => {
    const { media } = rig();
    await expect(openStableCamera(media, undefined, () => false)).rejects.toMatchObject({ name: "AbortError" });
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();
  });

  it("releases a late permission grant after Stop and never opens a second lens", async () => {
    const { media, active } = rig([]);
    let current = true;
    media.getUserMedia.mockImplementationOnce(async () => { current = false; return active.value; });
    await expect(openStableCamera(media, undefined, () => current)).rejects.toMatchObject({ name: "AbortError" });
    expect(active.track.stop).toHaveBeenCalledOnce();
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  });

  it("releases a late exact-camera stream after switching cameras", async () => {
    const { media, active } = rig();
    let current = true;
    media.getUserMedia.mockImplementationOnce(async () => { current = false; return active.value; });
    await expect(openStableCamera(media, "front", () => current)).rejects.toMatchObject({ name: "AbortError" });
    expect(active.track.stop).toHaveBeenCalledOnce();
  });

  it("stops the probe if cancellation occurs during label discovery", async () => {
    const { media, active } = rig([]);
    let current = true;
    media.enumerateDevices.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      current = false;
      return cameras;
    });
    await expect(openStableCamera(media, undefined, () => current)).rejects.toMatchObject({ name: "AbortError" });
    expect(active.track.stop).toHaveBeenCalledOnce();
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  });
});
