import type { Rng } from "@onestepchess/core";

// Server-owned word-list generator (`gentle-rook-042` style) for game names
// and nickname suggestions — product copy, not domain math (spec §2 ruling).
// Every combination satisfies the nickname rule ^[a-zA-Z0-9_-]{3,24}$.

const ADJECTIVES = [
  "gentle",
  "brave",
  "quiet",
  "swift",
  "bold",
  "calm",
  "clever",
  "daring",
  "eager",
  "fierce",
  "humble",
  "jolly",
  "keen",
  "lively",
  "merry",
  "noble",
  "patient",
  "proud",
  "rapid",
  "sly",
  "steady",
  "stern",
  "subtle",
  "tough",
  "vivid",
  "wary",
  "wild",
  "wise",
  "witty",
  "zesty",
  "amber",
  "coral",
  "golden",
  "ivory",
  "jade",
  "lunar",
  "misty",
  "polar",
  "royal",
  "silver",
  "solar",
  "stormy",
  "sunny",
  "velvet",
  "winter",
  "shadow",
] as const;

const PIECES = ["pawn", "knight", "bishop", "rook", "queen", "king"] as const;

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))] as T;
}

export function generateName(rng: Rng): string {
  const number = Math.floor(rng() * 1000)
    .toString()
    .padStart(3, "0");
  return `${pick(rng, ADJECTIVES)}-${pick(rng, PIECES)}-${number}`;
}
