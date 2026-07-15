import { isValidAddress } from "algosdk";

export function isValidAlgorandAddress(address: string): boolean {
  return isValidAddress(address);
}
