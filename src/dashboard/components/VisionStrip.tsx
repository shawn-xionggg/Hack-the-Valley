import type { WashMethod } from "../../shared/events";
import {
  HANDS_OUT_OF_VIEW, HAND_WASH_ARIA, NO_WASH_NOTE, SINK_LABEL, SINK_PROMPTS, TRACKING_LABELS, UTENSIL_PROGRESS_CAPTION,
  UTENSIL_WASH_ARIA, WASH_LABEL, WASH_METHODS, clockTime,
} from "../labels";
import type { VisionFrame } from "../useLiveVision";

interface Props {
  frame: VisionFrame | null;
  lastWash: { method: WashMethod; t: number } | null;
}

const RADIUS = 34;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** One dwell ring; the viewBox is fixed, so CSS sets the size. */
function Ring({ progress, label, className }: { progress: number; label: string; className: string }) {
  return (
    <div className={className} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}>
      <svg viewBox="0 0 80 80">
        <circle className="track" cx="40" cy="40" r={RADIUS} />
        <circle className="fill" cx="40" cy="40" r={RADIUS} strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - progress)} />
      </svg>
      <span>{Math.round(progress * 100)}%</span>
    </div>
  );
}

/** Sink dwell rings (hands, plus tongs while they're in the sink too) and the live vision readouts. */
export function VisionStrip({ frame, lastWash }: Props) {
  const status = frame?.status;
  const progress = status?.washProgress ?? 0;
  const utensilProgress = status?.utensilWashProgress ?? 0;
  const tracking = status?.utensils.tongs.tracking;
  const prompt = utensilProgress > 0 ? SINK_PROMPTS.utensil : progress > 0 ? SINK_PROMPTS.hands
    : status ? SINK_PROMPTS.idle : SINK_PROMPTS.off;
  return (
    <div className="vision-strip">
      <div className="wash-rings">
        <Ring className="wash-ring" progress={progress} label={HAND_WASH_ARIA} />
        {/* A3: only while hands and a jaw end share the sink, so Act 1's hands-only wash shows one ring. */}
        {utensilProgress > 0 && (
          <figure className="utensil-ring">
            <Ring className="wash-ring small" progress={utensilProgress} label={UTENSIL_WASH_ARIA} />
            <figcaption>{UTENSIL_PROGRESS_CAPTION}</figcaption>
          </figure>
        )}
      </div>
      <div className="wash-text">
        <span className="readout-label">{SINK_LABEL}</span>
        <strong>{prompt}</strong>
        <span className="readout-note">
          {lastWash ? `${WASH_LABEL} · ${WASH_METHODS[lastWash.method]} · ${clockTime(lastWash.t)}` : NO_WASH_NOTE}
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
