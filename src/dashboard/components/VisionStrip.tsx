import type { WashMethod } from "../../shared/events";
import { HANDS_OUT_OF_VIEW, TRACKING_LABELS, WASH_LABEL, WASH_METHODS, clockTime } from "../labels";
import type { VisionFrame } from "../useLiveVision";

interface Props {
  frame: VisionFrame | null;
  lastWash: { method: WashMethod; t: number } | null;
}

const RADIUS = 34;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Wash progress ring plus the live vision readouts (hands visible, tong tracking, fps). */
export function VisionStrip({ frame, lastWash }: Props) {
  const status = frame?.status;
  const progress = status?.washProgress ?? 0;
  const tracking = status?.utensils.tongs.tracking;
  return (
    <div className="vision-strip">
      <div className="wash-ring" role="progressbar" aria-label="Wash station dwell" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}>
        <svg viewBox="0 0 80 80">
          <circle className="track" cx="40" cy="40" r={RADIUS} />
          <circle className="fill" cx="40" cy="40" r={RADIUS} strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - progress)} />
        </svg>
        <span>{Math.round(progress * 100)}%</span>
      </div>
      <div className="wash-text">
        <span className="readout-label">Wash station</span>
        <strong>{progress > 0 ? "Hold hands at the wash station…" : status ? "Waiting for hands" : "Camera off"}</strong>
        <span className="readout-note">
          {lastWash ? `${WASH_LABEL} · ${WASH_METHODS[lastWash.method]} · ${clockTime(lastWash.t)}` : "No wash this session"}
        </span>
      </div>
      <dl className="readouts">
        <div><dt>Hands visible</dt><dd className={status?.handsVisible === 0 ? "warn" : undefined}>{status ? status.handsVisible : "—"}</dd></div>
        <div><dt>Tongs</dt><dd className={tracking === "lost" ? "warn" : undefined}>{tracking ? TRACKING_LABELS[tracking] : "—"}</dd></div>
        <div><dt>Inference</dt><dd>{status ? `${status.fps} fps` : "—"}</dd></div>
      </dl>
      {status?.handsVisible === 0 && <p className="readout-note warn hands-note">{HANDS_OUT_OF_VIEW}</p>}
    </div>
  );
}
