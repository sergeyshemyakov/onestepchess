import type { GameResult, Phase, Termination } from "../types.js";

export type TerminalStatus =
  | { readonly over: false }
  | {
      readonly over: true;
      readonly result: Exclude<GameResult, "aborted">;
      readonly termination: Exclude<Termination, "aborted">;
    };

export interface TurnGame<S, M> {
  initial(): S;
  legalMoves(state: S): readonly M[];
  apply(state: S, move: M): S;
  terminal(state: S): TerminalStatus;
  phase(state: S): Phase;
  encode(state: S): string;
  history(state: S): readonly M[];
}
