// Prints a Markdown table of rig trial results from the dev page's "Export JSON" files.
// Usage: npm run tally -- --expect tongs-tip [--attempts 20] [--gap 1500] trials/tip-1.json [more.json …]
// Run via tsx (not type-checked by `npm run typecheck`); the logic lives in src/vision/trials.ts.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_ATTEMPT_GAP_MS, TRIAL_TARGETS, tallyTrial } from "../src/vision/trials";
import type { TrialTally, TrialTarget, VisionEvent } from "../src/vision/trials";

function fail(message: string): never {
  console.error(`${message}\n\nUsage: npm run tally -- --expect <${TRIAL_TARGETS.join("|")}> [--attempts N] [--gap MS] <export.json …>`);
  process.exit(1);
}

let expected: TrialTarget | undefined;
let attempts: number | null = null;
let gapMs = DEFAULT_ATTEMPT_GAP_MS;
const files: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  const value = () => args[++i] ?? fail(`${arg} needs a value.`);
  if (arg === "--expect") {
    const target = value();
    if (!(TRIAL_TARGETS as readonly string[]).includes(target)) fail(`Unknown target "${target}".`);
    expected = target as TrialTarget;
  } else if (arg === "--attempts" || arg === "--gap") {
    const number = Number(value());
    if (!Number.isInteger(number) || number < 0) fail(`${arg} must be a whole number.`);
    if (arg === "--attempts") attempts = number; else gapMs = number;
  } else if (arg.startsWith("--")) fail(`Unknown option ${arg}.`);
  else files.push(arg);
}
if (!expected) fail("Missing --expect.");
if (!files.length) fail("Give at least one exported JSON file.");

function readEvents(file: string): VisionEvent[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { fail(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const events = (parsed as { events?: unknown })?.events;
  if (!Array.isArray(events)) fail(`${file} has no "events" array. Is it a GhostTrace "Export JSON" file?`);
  return events.filter((e): e is VisionEvent => e?.kind === "contact" || e?.kind === "wash" || e?.kind === "utensil-washed");
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const row = (label: string, t: TrialTally) => `| ${[
  label, t.attempts ?? "?", t.registered, t.outcomes.correct, t.outcomes["fired-twice"], t.outcomes["wrong-tong-part"],
  t.outcomes["wrong-wash"], t.outcomes.unexpected, t.missed ?? "—", t.confidence ? `${pct(t.confidence.min)} / ${pct(t.confidence.mean)}` : "—",
].join(" | ")} |`;

const tallies = files.map(file => ({ file, tally: tallyTrial(readEvents(file), expected!, attempts, gapMs) }));
console.log(`Expected: **${expected}** · attempt gap ${gapMs} ms\n`);
console.log("| File | Attempts | Registered | Correct | Fired twice | Wrong tong part | Wrong wash | Unexpected | Missed | Confidence (min / mean) |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const { file, tally } of tallies) console.log(row(basename(file), tally));
if (tallies.length > 1) {
  // Totals re-tally all events together; a large gap keeps files from merging into one attempt.
  const all = files.flatMap((file, i) => readEvents(file).map(e => ({ ...e, t: e.t + i * 1e9 })));
  console.log(row("**Total**", tallyTrial(all, expected, attempts === null ? null : attempts * files.length, gapMs)));
}
