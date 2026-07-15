export function shortenAddress(address: string, visible = 4): string {
  if (address.length <= visible * 2) {
    return address;
  }
  return `${address.slice(0, visible)}…${address.slice(-visible)}`;
}
