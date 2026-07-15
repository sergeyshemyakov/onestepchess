const FILES = "abcdefgh";

export function toAlgebraic(file: number, rank: number): string {
  const letter = FILES[file];
  if (letter === undefined || rank < 0 || rank > 7) {
    throw new RangeError(`square out of range: file=${file} rank=${rank}`);
  }
  return `${letter}${rank + 1}`;
}
