export const FUNDING_AMOUNT = '0.05';
export const FUNDING_MEMO = 'private-recurring:wallet-funding:v1';
export function assertTestnet(address) {
  if (typeof address === 'string' && address.startsWith('u1')) throw new Error('Mainnet Noir answered this connection. Temporarily disable the mainnet extension, keep [Testnet] Noir Wallet enabled, then reload this page.');
  if (typeof address !== 'string' || !/^utest1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(address)) throw new Error('A Noir testnet unified address is required. Install the testnet extension.');
}
export function fundingRequest(destination, account) {
  assertTestnet(destination);
  assertTestnet(account);
  if (destination === account) throw new Error('Funding and operating wallets must be separate.');
  return {to: destination, amount: FUNDING_AMOUNT, memo: FUNDING_MEMO, fundingSource: 'shielded'};
}
export function formatZatoshis(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 'Not synced';
  const z = BigInt(value);
  return `${z / 100000000n}.${(z % 100000000n).toString().padStart(8, '0')}`;
}
