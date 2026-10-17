import type { ChainStep, EngineState, ExposureRecord } from "../shared/engine-types";

export type ChainResult =
  | { ok: true; chain: ChainStep[] }
  | { ok: false; error: "missing-record" | "duplicate-record" | "cycle" | "invalid-link" | "invalid-event"; recordId: string };

/** Reconstruct recorded ancestry, including cleared records. Never returns a partial explanation. */
export function buildExposureChain(state: EngineState, recordId: string): ChainResult {
  const records = new Map<string, ExposureRecord>();
  const duplicates = new Set<string>();
  for (const record of state.records) {
    if (records.has(record.id)) duplicates.add(record.id);
    records.set(record.id, record);
  }
  const visited = new Set<string>();
  const reverse: ChainStep[] = [];
  let currentId = recordId;
  while (true) {
    const fail = (error: Extract<ChainResult, { ok: false }>["error"]): ChainResult => ({ ok: false, error, recordId: currentId });
    if (visited.has(currentId)) return fail("cycle");
    if (duplicates.has(currentId)) return fail("duplicate-record");
    const record = records.get(currentId);
    if (!record) return fail("missing-record");
    visited.add(currentId);
    if (record.kind === "origin") {
      if (record.parentRecordId !== null || record.fromSurfaceId !== null || record.causedByEventId !== null) return fail("invalid-link");
      reverse.push({ kind: "origin", surfaceId: record.surfaceId, allergen: record.allergen, recordId: record.id });
      return { ok: true, chain: reverse.reverse() };
    }
    if (!record.parentRecordId || !record.fromSurfaceId || !record.causedByEventId) return fail("invalid-link");
    // Detect cycles before validating the parent metadata so callers get a useful error.
    if (visited.has(record.parentRecordId)) return fail("cycle");
    const parent = records.get(record.parentRecordId);
    if (!parent) return { ok: false, error: "missing-record", recordId: record.parentRecordId };
    if (parent.surfaceId !== record.fromSurfaceId || parent.allergen !== record.allergen || parent.surfaceId === record.surfaceId) return fail("invalid-link");
    // Duplicate delivery attempts are not new evidence; only the applied event counts.
    const evidence = state.log.filter(entry => entry.event.id === record.causedByEventId && entry.effect === "applied");
    const event = evidence[0]?.event;
    if (evidence.length !== 1 || !event || event.kind !== "contact" || event.t !== record.t ||
        !((event.a === parent.surfaceId && event.b === record.surfaceId) ||
          (event.b === parent.surfaceId && event.a === record.surfaceId))) return fail("invalid-event");
    reverse.push({ kind: "transfer", from: record.fromSurfaceId, to: record.surfaceId,
      allergen: record.allergen, eventId: record.causedByEventId, recordId: record.id, t: record.t });
    currentId = record.parentRecordId;
  }
}
