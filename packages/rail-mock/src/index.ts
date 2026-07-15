export interface MockSettlement {
  readonly id: string;
  readonly amountMicroUsdc: bigint;
}

export function totalSettled(settlements: readonly MockSettlement[]): bigint {
  return settlements.reduce((sum, s) => sum + s.amountMicroUsdc, 0n);
}
