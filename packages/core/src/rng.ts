export type Rng = () => number;

function multiply32(left: number, right: number): number {
  const leftLow = left & 0xffff;
  const leftHigh = left >>> 16;
  const rightLow = right & 0xffff;
  const rightHigh = right >>> 16;
  return (
    (leftLow * rightLow + ((leftHigh * rightLow + leftLow * rightHigh) << 16)) |
    0
  );
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = multiply32(value ^ (value >>> 15), value | 1);
    value ^= value + multiply32(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
