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

Registry initialization, contact transfer, and `createEngine` (below) are
implemented. No tracked exposure is not a safety guarantee.

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

## Two-marker tong tracking (A1)

Markers 11 and 12 identify alternative views of the same utensil. CV chooses a
calibrated view and emits contacts using `tongs-tip` or `tongs-handle`; the registry
never creates marker-number surfaces. Switching visible markers or losing tracking
does not clear exposure. Pose selection, calibration, and tracking-loss display
belong to CV/dashboard; this engine does not inspect camera frames or marker IDs.

Contact processing checks duplicate IDs first, then validates the pair, then
checks confidence. Hands may touch any shared contact target; a tong part may
touch only peanut-source or meal-1. Invalid pairs are logged as
`ignored-invalid-contact` without changing exposure. This guard checks pairs,
not the entire untyped event payload.

Fresh IDs from held contacts can transfer newly arrived exposure; repeated IDs
are ignored and already-active exposure is not duplicated. Tests cover tool-only
chains, reverse transfers, handle-to-hand re-exposure, forbidden pairs, confidence,
and continuity of logical IDs. Actual marker switching still needs CV integration
tests. Shared types, registry IDs, and chain reconstruction remain unchanged.

## Engine (`createEngine`)

`createEngine({ orders?, tuning? })` in `engine.ts` implements the shared `Engine`
API on top of the registry, `applyContact` and `buildExposureChain`. `dispatch`
checks duplicate IDs across every event kind first, then applies spec §3.5:
contacts (through `applyContact`), washes (hands only), utensil replacement (tip
and handle together), acknowledgements (alert only), and session reset (fresh
registry, new deterministic session ID `session-N`). After each applied contact it
raises at most one `alert:<mealId>:<allergen>` per meal and allergen; the alert
chain is the recorded ancestry plus every wash that cleared a record on that path,
origin first, then by time. Surface statuses are rebuilt from records and alerts
after every event, so a meal with an alert stays `action-required` until reset.

Every dispatch returns a new state object and notifies subscribers. It never
throws: malformed events are logged as `no-change` or skipped, and a failing
listener is reported to the console. `engine.test.ts` runs all fifteen
`SCENARIOS` from `src/sim/fixtures.ts`, including per-step statuses and chains.
