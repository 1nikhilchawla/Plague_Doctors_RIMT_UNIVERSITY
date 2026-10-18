import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getSimWard, simWardFromSnapshot, simWardSnapshot, type SimWardSnapshot } from "./cohort.ts";

describe("ward_snapshot_fresh", () => {
  it("matches a fresh build of the simulated ward (run `npm run snapshot` after model changes)", () => {
    const committed = JSON.parse(
      readFileSync(new URL("./ward_snapshot.json", import.meta.url), "utf8"),
    ) as SimWardSnapshot;
    const live = getSimWard();
    const fresh = JSON.parse(JSON.stringify(simWardSnapshot(live))) as SimWardSnapshot;
    assert.deepEqual(committed, fresh);
    const hydrated = simWardFromSnapshot(committed);
    assert.equal(hydrated.patients.length, live.patients.length);
    hydrated.patients.forEach((model, i) => {
      const source = live.patients[i]!;
      assert.equal(model.patient.id, source.patient.id);
      assert.deepEqual(model.readings, source.readings);
      assert.deepEqual(model.meals, source.meals);
      assert.deepEqual(Array.from(model.spikeProb), Array.from(source.spikeProb));
      assert.deepEqual(Array.from(model.active), Array.from(source.active));
      assert.deepEqual(model.alertSetup, source.alertSetup);
    });
  });
});
