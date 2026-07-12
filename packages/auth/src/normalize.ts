export function normalizePubkey(pubkey: string): string {
  return pubkey.trim().toLowerCase().replace(/^0x/, "");
}
