# Object registry

`createObjectRegistry(sessionId)` creates fresh initial `EngineState` from the
existing shared configuration. The session ID is explicit for deterministic
replay. The peanut source starts with an active origin record. Hands, tong tips,
tong handle, and meal start with no tracked exposure; the wash station carries
no exposure state. Each surface and session owns independent arrays.

Run from the repository root in the VS Code terminal:

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run demo:registry
```

Tests cover initial records and statuses, isolation between surfaces and sessions,
unchanged shared configuration, reproducibility, and invalid session IDs.

Registry initialization and contact transfer are implemented. Wash and
replacement handling, alerts, subscriptions, and `createEngine` are not yet
implemented. The ten scenarios in `src/sim/fixtures.ts` will exercise that engine
in the next milestone. No tracked exposure is not a safety guarantee.

## Contact propagation

`applyContact(state, event, minConfidence?)` returns a new state without mutating
its input. Pass a typed `ContactEvent` from the shared contract. It snapshots
both surfaces, transfers active allergens in either direction, records parent
exposure IDs, updates statuses, and logs applied, no-change, low-confidence,
and duplicate-ID outcomes. The default confidence threshold is shared tuning.
Repeated IDs (including previously ignored events) are ignored for this session.
Cleared records remain in history but do not propagate. Tip and handle never
transfer implicitly. Pass the returned state into the next call.

This reducer does not implement the full `createEngine` interface or runtime
validation of untyped camera payloads. Wash, replacement, reset, order alerts,
and subscriptions remain future work. A meal reached by exposure gets
`potential-exposure`; the future alert layer will set `action-required`.


## Reconstructing exposure history

Call `buildExposureChain(state, recordId)` with an exposure record ID, for example
one from `state.surfaces["tongs-tip"].activeRecordIds`. On success it returns
`{ ok: true, chain }`, using the shared `ChainStep` format in causal order from
origin to destination. Each transfer includes its event ID and timestamp.
Equal timestamps retain parent-before-child order. This reads memory only;
it does not save history to disk or connect the UI to live events.

The function checks parent links against the applied contact events in `state.log`.
Ignored duplicate deliveries are not evidence. Missing records, cycles, ambiguous
record IDs, inconsistent links, or missing/mismatched event evidence return
`{ ok: false, error, recordId }` with no partial chain. Callers should show history
as unavailable on failure, not present a shortened path as complete.

Cleared exposure records remain traceable. This milestone reconstructs origins
and transfers only; insertion of wash steps will accompany wash handling.
Alerts and the full engine dispatcher remain separate work.
