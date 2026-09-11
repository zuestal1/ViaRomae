/**
 * Schildwall starts during the guard's initiative slot. The rest of that round
 * therefore cannot be considered a complete opposing phase. Its trigger is the
 * end of the opposing phase in the following round, independent of turn order.
 */
export interface OpponentPhaseLifetime {
  activatedAtRound: number;
  expiresAfterOpponentPhaseRound: number;
}

export function nextCompleteOpponentPhase(activatedAtRound: number): OpponentPhaseLifetime {
  return { activatedAtRound, expiresAfterOpponentPhaseRound: activatedAtRound + 1 };
}

export function isOpponentPhaseEffectActive(
  lifetime: Partial<OpponentPhaseLifetime>, roundNumber: number,
): boolean {
  return typeof lifetime.expiresAfterOpponentPhaseRound === "number" &&
    roundNumber <= lifetime.expiresAfterOpponentPhaseRound;
}

export function hasOpponentPhaseCompleted(
  lifetime: Partial<OpponentPhaseLifetime>, resolvedRound: number,
): boolean {
  return typeof lifetime.expiresAfterOpponentPhaseRound === "number" &&
    resolvedRound >= lifetime.expiresAfterOpponentPhaseRound;
}
