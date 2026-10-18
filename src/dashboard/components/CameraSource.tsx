interface Props {
  cameras: MediaDeviceInfo[];
  requestedId: string;
  activeId: string;
  onChange(deviceId: string): void;
}

export function CameraSource({ cameras, requestedId, activeId, onChange }: Props) {
  return (
    <select aria-label="Camera source" value={requestedId || activeId} onChange={event => onChange(event.target.value)}>
      <option value="">Auto — main rear camera</option>
      {cameras.map((camera, i) => (
        <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${i + 1}`}</option>
      ))}
    </select>
  );
}
