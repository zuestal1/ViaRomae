import assert from "node:assert/strict";
import test from "node:test";
import { hasOpponentPhaseCompleted, isOpponentPhaseEffectActive,
  nextCompleteOpponentPhase } from "../src/modules/combat/combat-effect-lifetime.js";

for (const combatType of ["PVE", "PVP", "BOSS"] as const) {
  test(`${combatType}: Schildwall survives the round boundary with the guard before an opponent`, () => {
    const lifetime = nextCompleteOpponentPhase(4);
    const initiativeOrder = ["guard", "opponent"];
    assert.equal(isOpponentPhaseEffectActive(lifetime, 4), true);
    assert.equal(initiativeOrder[1], "opponent");
    assert.equal(hasOpponentPhaseCompleted(lifetime, 4), false);
    assert.equal(isOpponentPhaseEffectActive(lifetime, 5), true);
    assert.equal(hasOpponentPhaseCompleted(lifetime, 5), true);
    assert.equal(isOpponentPhaseEffectActive(lifetime, 6), false);
  });

  test(`${combatType}: Schildwall is not shortened when the guard acts after an opponent`, () => {
    const lifetime = nextCompleteOpponentPhase(9);
    const initiativeOrder = ["opponent", "guard"];
    assert.equal(initiativeOrder[0], "opponent");
    assert.equal(isOpponentPhaseEffectActive(lifetime, 9), true);
    assert.equal(hasOpponentPhaseCompleted(lifetime, 9), false,
      "the partial activation round is not the protected full opposing phase");
    assert.equal(isOpponentPhaseEffectActive(lifetime, 10), true);
    assert.equal(hasOpponentPhaseCompleted(lifetime, 10), true);
  });
}
