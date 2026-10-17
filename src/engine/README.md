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

This is the registry initialization milestone. Contact transfer, wash and
replacement handling, alerts, subscriptions, and `createEngine` are not yet
implemented. The ten scenarios in `src/sim/fixtures.ts` will exercise that engine
in the next milestone. No tracked exposure is not a safety guarantee.
