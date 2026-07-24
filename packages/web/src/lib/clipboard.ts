/** Clipboard access is optional and can reject even when the API exists. */
export async function copyText(value: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) return false;
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
