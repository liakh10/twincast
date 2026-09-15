/* The two chains Twincast lives on. The factory and router sit at the same address on both. */
export const CHAINS = {
  4663: {
    id: 4663, key: 'robinhood', name: 'Robinhood Chain', short: 'Robinhood',
    rpc: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'],
    explorer: 'https://robinscan.io', dex: 'robinhood',
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904'
  },
  8453: {
    id: 8453, key: 'base', name: 'Base', short: 'Base',
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org', dex: 'base',
    poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b', stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
    universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43'
  }
};
export const CHAIN_IDS = [4663, 8453];
export const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export function viemChain(id) {
  const c = CHAINS[id];
  return {
    id: c.id, name: c.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: c.rpc } }, blockExplorers: { default: { name: c.short + ' explorer', url: c.explorer } },
    contracts: { multicall3: { address: MULTICALL3 } }
  };
}
export const explorer = (id, kind, v) => `${CHAINS[id].explorer}/${kind}/${v}`;
