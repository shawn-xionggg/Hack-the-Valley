import type { LoggedEvent } from "../../shared/engine-types";
import { EFFECT_LABELS, clockTime, eventText } from "../labels";

const SHOWN = 40;

/** Event history across sessions, newest first, including reset and ignored events. */
export function EventLog({ log }: { log: LoggedEvent[] }) {
  if (!log.length) return <p className="empty-note">No events yet this session.</p>;
  return (
    <ol className="event-log">
      {log.slice(-SHOWN).reverse().map((entry, i) => (
        <li key={`${log.length - i}:${entry.event.id}`} className={entry.effect.startsWith("ignored") ? "ignored" : entry.effect}>
          <time>{clockTime(entry.event.t)}</time>
          <span className="event-text">{eventText(entry)}</span>
          <span className="event-effect">{EFFECT_LABELS[entry.effect]}</span>
          <span className={`event-source ${entry.event.source}`}>{entry.event.source}</span>
        </li>
      ))}
    </ol>
  );
}
