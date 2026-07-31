export function winratePct(wins: number, losses: number): number | null {
  const decisiveGames = wins + losses;
  return decisiveGames === 0 ? null : (wins / decisiveGames) * 100;
}
