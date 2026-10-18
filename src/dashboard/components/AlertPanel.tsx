import { ORDERS } from "../../shared/config";
import type { Alert } from "../../shared/engine-types";
import { ACK_NOTE, CORRECTIVE_ACTION, STATUS_LABELS, chainPath, chainStepText, clockTime } from "../labels";

interface Props {
  alerts: Alert[];
  onAcknowledge(alertId: string): void;
}

export function AlertPanel({ alerts, onAcknowledge }: Props) {
  if (!alerts.length) {
    return <p className="empty-note">No active alerts. An alert is raised when tracked exposure reaches a meal whose order declares that allergy.</p>;
  }
  // Newest first: during a demo the alert that just fired is the one to explain.
  return <>{[...alerts].reverse().map(alert => <AlertCard key={alert.id} alert={alert} onAcknowledge={onAcknowledge} />)}</>;
}

function AlertCard({ alert, onAcknowledge }: { alert: Alert; onAcknowledge(alertId: string): void }) {
  const order = ORDERS.find(o => o.id === alert.orderId);
  return (
    <article className={`alert-card${alert.acknowledged ? " acknowledged" : ""}`} role="alert">
      <header>
        <h3>{STATUS_LABELS["action-required"]}</h3>
        <span className="alert-meta">{order?.displayName ?? alert.orderId} · {alert.allergen} allergy · {clockTime(alert.t)}</span>
      </header>
      {alert.chain.length ? (
        <>
          <p className="chain-path" aria-label="Exposure path">
            {chainPath(alert.chain).map((label, i) => (
              <span key={i} className={label.startsWith("[") ? "wash" : undefined}>{i > 0 && <span className="arrow" aria-hidden="true"> → </span>}{label}</span>
            ))}
          </p>
          <ol className="chain">
            {alert.chain.map(step => (
              <li key={step.kind === "wash" ? step.eventId : step.recordId} className={`chain-step ${step.kind}`}>
                <span>{chainStepText(step)}</span>
                <time>{step.kind === "origin" ? "session start" : clockTime(step.t)}</time>
              </li>
            ))}
          </ol>
        </>
      ) : <p className="empty-note">Exposure history unavailable for this alert.</p>}
      <p className="alert-action">{CORRECTIVE_ACTION}</p>
      {alert.acknowledged
        ? <p className="alert-ack">{ACK_NOTE}{alert.acknowledgedAt !== null && ` (${clockTime(alert.acknowledgedAt)})`}</p>
        : <button className="button danger" onClick={() => onAcknowledge(alert.id)}>Acknowledge alert</button>}
    </article>
  );
}
