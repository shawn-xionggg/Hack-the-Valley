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

