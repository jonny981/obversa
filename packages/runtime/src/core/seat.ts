/**
 * Seat validation shared by the job layer (`agentJob`) and the review layer
 * (`review`, `refinedRounds`, `workflow`). A `TeamSeat` stays one bound
 * engine with one exact identity; a `SeatAlternatives` names that seat's
 * ordered alternatives, each a full seat of its own.
 */

import { seatsOf, type ExecutionTarget, type SeatChoice, type TeamSeat } from '@obversa/api';

/** An identity names every field an engine binding is keyed by. */
export function assertExecutionTarget(identity: unknown): asserts identity is ExecutionTarget {
  const value = identity as ExecutionTarget | undefined;
  if (
    !value
    || typeof value.adapter !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.modelFamily !== 'string'
    || typeof value.model !== 'string'
    || !Array.isArray(value.tools)
    || !value.adapter.trim()
    || !value.provider.trim()
    || !value.model.trim()
    || !value.modelFamily.trim()
  ) {
    throw new TypeError('engine identity must contain adapter, provider, model family, and model');
  }
}

export function seatIdentity(seat: TeamSeat): TeamSeat['identity'] {
  const identity = seat?.identity;
  assertExecutionTarget(identity);
  return identity;
}

export function assertDistinctSeats(seats: readonly TeamSeat[]): void {
  const identities = seats.map((seat, index) => {
    try {
      return seatIdentity(seat);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'invalid engine identity';
      throw new TypeError(`seat ${index + 1} has an invalid engine identity: ${message}`, { cause });
    }
  });
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
      const left = identities[leftIndex]!;
      const right = identities[rightIndex]!;
      const sameFamily = left.modelFamily === right.modelFamily;
      if (!sameFamily) continue;
      throw new TypeError(
        `seats ${leftIndex + 1} and ${rightIndex + 1} report the same model family ${left.modelFamily}; model family must be distinct per seat`,
      );
    }
  }
}

/** Whether `value` is a `{ seat, candidates }` rather than a bare `TeamSeat`. */
export function isSeatAlternatives(value: unknown): value is { readonly seat: TeamSeat; readonly candidates: readonly TeamSeat[] } {
  return typeof value === 'object' && value !== null && 'candidates' in value;
}

/**
 * Every seat a choice can run as, in try order, each validated. An empty
 * candidate list is refused, as is any entry that is not a full seat.
 */
export function seatList(choice: SeatChoice): readonly TeamSeat[] {
  if (!isSeatAlternatives(choice)) {
    seatIdentity(choice);
    return [choice];
  }
  if (!Array.isArray(choice.candidates) || choice.candidates.length === 0) {
    throw new TypeError('a seat with alternatives takes a non-empty candidates list');
  }
  const seats = seatsOf(choice);
  seats.forEach((seat, index) => {
    try {
      seatIdentity(seat);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'invalid engine identity';
      throw new TypeError(`candidate ${index + 1} has an invalid engine identity: ${message}`, { cause });
    }
  });
  return seats;
}

/**
 * The distinct-family rule over choices: every candidate a seat can resolve
 * to counts, so no reachable combination of two seats shares a family. Two
 * alternatives inside one seat may share a family; two seats never may.
 */
export function assertDistinctChoices(choices: readonly SeatChoice[]): void {
  const families = choices.map((choice) => new Set(seatList(choice).map((seat) => seat.identity.modelFamily)));
  for (let leftIndex = 0; leftIndex < families.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < families.length; rightIndex += 1) {
      const collision = [...families[leftIndex]!].find((family) => families[rightIndex]!.has(family));
      if (collision !== undefined) {
        throw new TypeError(
          `seats ${leftIndex + 1} and ${rightIndex + 1} can resolve to the same model family ${collision}; model family must be distinct per seat`,
        );
      }
    }
  }
}
