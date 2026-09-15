/* Twincast data layer: launches from the factory on both chains merged by address, prices and uncollected fees from
   each chain's Uniswap v4 StateView, address prediction and salt search, quotes by simulating the router, and every
   action. Every call names its chain. */
import { pubs, state as wallet, send } from './wallet.js';
import { CHAINS, CHAIN_IDS } from './chains.js';
import { parseEther, parseAbi, encodeAbiParameters, keccak256, decodeEventLog, erc20Abi, concat, getAddress } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';

const valid = v => /^0x[0-9a-fA-F]{40}$/.test(v || '') ? v : null;
export const FACTORY = valid(window.TWIN_FACTORY);
export const ROUTER = valid(window.TWIN_ROUTER);
export const BUYBACK = valid(window.TWIN_BUYBACK);
export const ZERO = '0x0000000000000000000000000000000000000000';
export const OPEN_TICK = 207200, CURVE_TICKS = 27800, POOL_FEE = 10000, SUFFIX = '2222';
const MAX_TICK = 887200, Q128 = 1n << 128n, M256 = 1n << 256n;
const ETH_USD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
const SV = parseAbi([
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
  'function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)',
  'function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns (uint128,uint256,uint256)'
]);
const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);

let A = null;
export async function abis() {
  if (A) return A;
  const get = async n => { for (let i = 0; i < 3; i++) { try { const r = await fetch('/lib/abi/' + n + '.json?v=1'); if (r.ok) return r.json(); } catch {} await new Promise(r => setTimeout(r, 400 * (i + 1))); } throw Error('Could not load ' + n); };
  const [T, F, R, B] = await Promise.all(['TwinToken', 'TwinFactory', 'TwinRouter', 'TwinBuyback'].map(get));
  A = { T: T.abi, tokenCode: T.bytecode, F: F.abi, R: R.abi, B: B.abi };
  return A;
}

export const keyOf = token => ({ currency0: ZERO, currency1: token, fee: POOL_FEE, tickSpacing: 200, hooks: ZERO });
export const poolId = k => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
export const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
export const eth = wei => Number(wei || 0n) / 1e18;
export const fmtEth = v => { v = Number(v || 0); return v === 0 ? '0' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(5); };
export const fmtTok = wei => { const n = Number(wei || 0n) / 1e18; return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2); };

export async function ethUsd() {
  try { const r = await pubs[4663].readContract({ address: ETH_USD, abi: FEED, functionName: 'latestRoundData' }); return Number(r[1]) / 1e8; } catch { return null; }
}

// ---------------------------------------------------------------- addresses

export async function codeHash(launcher, name, symbol, uri) {
  const { tokenCode } = await abis();
  return keccak256(concat([tokenCode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'address' }], [name, symbol, uri, ROUTER, launcher])]));
}
export const saltOf = (launcher, userSalt) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [launcher, userSalt]));
export async function predict(launcher, userSalt, name, symbol, uri) {
  const h = await codeHash(launcher, name, symbol, uri);
  return getAddress('0x' + keccak256(concat(['0xff', FACTORY, saltOf(launcher, userSalt), h])).slice(-40));
}

/* finds a salt whose token address ends in SUFFIX, in a web worker */
export async function mineSalt({ launcher, name, symbol, uri }, onProgress) {
  if (!FACTORY || !ROUTER) throw Error('Twincast is not deployed yet');
  const hash = await codeHash(launcher, name, symbol, uri);
  return new Promise((resolve, reject) => {
    const w = new Worker('/lib/miner.js', { type: 'module' });
    w.onmessage = e => {
      if (e.data.progress) { onProgress && onProgress(e.data.progress); return; }
      w.terminate();
      if (e.data.error) reject(Error(e.data.error));
      else resolve({ userSalt: e.data.userSalt, address: getAddress(e.data.address) });
    };
    w.onerror = () => { w.terminate(); reject(Error('The address search could not start in this browser')); };
    w.postMessage({ factory: FACTORY, launcher, codeHash: hash, suffix: SUFFIX, start: Math.floor(Math.random() * 2 ** 40) });
  });
}

// ---------------------------------------------------------------- reads

async function loadChain(chainId) {
  if (!FACTORY) return [];
  const pub = pubs[chainId], C = CHAINS[chainId];
  const { F, T } = await abis();
  const n = Number(await pub.readContract({ address: FACTORY, abi: F, functionName: 'launchCount' }).catch(() => 0n));
  if (!n) return [];
  let list = [];
  for (let i = 0; i < n; i += 200) list = list.concat(await pub.readContract({ address: FACTORY, abi: F, functionName: 'launches', args: [BigInt(i), 200n] }));
  const cap = OPEN_TICK - CURVE_TICKS, ranges = [[cap, OPEN_TICK], [-MAX_TICK, cap]];
  const rows = list.map(l => ({ ...l, chainId, id: poolId(keyOf(l.token)), createdAt: Number(l.createdAt) }));
  const W = 8;
  const res = await pub.multicall({ allowFailure: true, contracts: rows.flatMap(r => [
    { address: r.token, abi: T, functionName: 'name' }, { address: r.token, abi: T, functionName: 'symbol' }, { address: r.token, abi: T, functionName: 'metadataURI' },
    { address: C.stateView, abi: SV, functionName: 'getSlot0', args: [r.id] },
    ...ranges.flatMap(([lo, hi]) => [
      { address: C.stateView, abi: SV, functionName: 'getFeeGrowthInside', args: [r.id, lo, hi] },
      { address: C.stateView, abi: SV, functionName: 'getPositionInfo', args: [r.id, FACTORY, lo, hi, '0x' + '0'.repeat(64)] }
    ])
  ]) });
  rows.forEach((r, i) => {
    const g = k => res[i * W + k].result;
    r.name = g(0) || ''; r.symbol = g(1) || ''; r.uri = g(2) || '';
    const s0 = g(3), s = s0 ? Number(s0[0]) / 2 ** 96 : 0;
    r.tick = s0 ? s0[1] : OPEN_TICK;
    r.priceEth = s ? 1 / (s * s) : 0;
    r.mcapEth = s ? 1e9 / (s * s) : null;
    r.progress = Math.max(0, (OPEN_TICK - r.tick) / CURVE_TICKS);
    let unc = 0n;
    for (let k = 0; k < 2; k++) { const inside = g(4 + k * 2), pos = g(5 + k * 2); if (inside && pos) unc += pos[0] * ((inside[0] - pos[1] + M256) % M256) / Q128; }
    r.uncollectedEth = unc;
  });
  return rows;
}

/* every token on both chains, merged by address, newest first */
export async function loadAll() {
  const perChain = await Promise.all(CHAIN_IDS.map(id => loadChain(id).catch(() => [])));
  const map = new Map();
  perChain.flat().forEach(r => {
    const k = r.token.toLowerCase();
    const e = map.get(k) || { token: r.token, name: r.name, symbol: r.symbol, uri: r.uri, creator: r.creator, createdAt: r.createdAt, chains: {} };
    e.chains[r.chainId] = r;
    e.createdAt = Math.min(e.createdAt, r.createdAt);
    map.set(k, e);
  });
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}

const metaCache = new Map();
export function meta(uri) {
  if (!/^https?:\/\//.test(uri || '')) return Promise.resolve(null);
  if (!metaCache.has(uri)) metaCache.set(uri, fetch(uri).then(r => r.ok ? r.json() : null).catch(() => null));
  return metaCache.get(uri);
}

/* the salt a token was launched with, read from its TokenLaunched event (block found by timestamp) */
export async function launchSalt(chainId, token, createdAt) {
  const pub = pubs[chainId];
  let lo = 0n, hi = await pub.getBlockNumber();
  for (let i = 0; i < 40 && lo < hi; i++) {
    const mid = (lo + hi) / 2n;
    const b = await pub.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) < createdAt) lo = mid + 1n; else hi = mid;
  }
  const ev = parseAbi(['event TokenLaunched(address indexed token, address indexed creator, bytes32 salt, string name, string symbol, string metadataURI, uint256 devEth, uint256 devTokens)'])[0];
  const logs = await pub.getLogs({ address: FACTORY, event: ev, args: { token }, fromBlock: lo > 20n ? lo - 20n : 0n, toBlock: lo + 20n });
  if (!logs.length) throw Error('Could not find the original launch');
  return { userSalt: logs[0].args.salt, creator: logs[0].args.creator };
}

export async function buybackStats() {
  if (!BUYBACK) return null;
  const { B } = await abis();
  const pub = pubs[4663];
  const res = await pub.multicall({ allowFailure: true, contracts: ['totalReceived', 'totalEthSpent', 'totalBurned', 'twin'].map(f => ({ address: BUYBACK, abi: B, functionName: f })) });
  return { received: res[0].result || 0n, spent: res[1].result || 0n, burned: res[2].result || 0n, twin: res[3].result || ZERO };
}

// ---------------------------------------------------------------- actions

const me = () => { const w = wallet(); if (!w.address) throw Error('Connect a wallet first'); return w.address; };
const DUMMY = '0x000000000000000000000000000000000000bEEF';
async function run(chainId, call, onStep) {
  onStep && onStep(`Confirm on ${CHAINS[chainId].short} in your wallet`);
  const t = await send(chainId, call);
  onStep && onStep(`Waiting for ${CHAINS[chainId].short}`);
  const rc = await t.wait();
  if (rc.status !== 'success') throw Error('Transaction reverted');
  return rc;
}

export async function launch(chainId, { name, symbol, uri, userSalt, devEth }, onStep) {
  const { F } = await abis();
  const w = me();
  let minOut = 0n;
  if (devEth > 0n) {
    onStep && onStep(`Quoting the first buy on ${CHAINS[chainId].short}`);
    const sim = await pubs[chainId].simulateContract({ account: w, address: FACTORY, abi: F, functionName: 'launch', args: [name, symbol, uri, userSalt, 0n], value: devEth });
    minOut = sim.result[1] * 95n / 100n;
  }
  const rc = await run(chainId, { address: FACTORY, abi: F, functionName: 'launch', args: [name, symbol, uri, userSalt, minOut], value: devEth }, onStep);
  for (const l of rc.logs) {
    try { const d = decodeEventLog({ abi: F, data: l.data, topics: l.topics }); if (d.eventName === 'TokenLaunched') return d.args.token; } catch {}
  }
  return null;
}

export async function quoteBuy(chainId, token, wei) {
  const { R } = await abis();
  const from = wallet().address || DUMMY;
  return (await pubs[chainId].simulateContract({ account: from, address: ROUTER, abi: R, functionName: 'buy', args: [token, 0n, from], value: wei, stateOverride: [{ address: from, balance: wei * 2n + parseEther('1') }] })).result;
}
export async function quoteSell(chainId, token, amount) {
  const { R } = await abis();
  const w = me();
  return (await pubs[chainId].simulateContract({ account: w, address: ROUTER, abi: R, functionName: 'sell', args: [token, amount, 0n, w] })).result;
}
export async function buy(chainId, token, wei, slippageBps, onStep) {
  const { R } = await abis();
  const w = me();
  onStep && onStep('Quoting');
  const out = await quoteBuy(chainId, token, wei);
  return run(chainId, { address: ROUTER, abi: R, functionName: 'buy', args: [token, out * BigInt(10000 - slippageBps) / 10000n, w], value: wei }, onStep);
}
export async function sell(chainId, token, amount, slippageBps, onStep) {
  const { R } = await abis();
  const w = me();
  onStep && onStep('Quoting');
  const out = await quoteSell(chainId, token, amount);
  return run(chainId, { address: ROUTER, abi: R, functionName: 'sell', args: [token, amount, out * BigInt(10000 - slippageBps) / 10000n, w] }, onStep);
}
export const collectFees = async (chainId, token, onStep) => run(chainId, { address: FACTORY, abi: (await abis()).F, functionName: 'collectFees', args: [token] }, onStep);
export const claim = async (chainId, onStep) => run(chainId, { address: FACTORY, abi: (await abis()).F, functionName: 'claim' }, onStep);
export const setFeeTo = async (chainId, token, to, onStep) => run(chainId, { address: FACTORY, abi: (await abis()).F, functionName: 'setFeeTo', args: [token, to] }, onStep);
export async function claimable(chainId, who) {
  if (!FACTORY || !who) return 0n;
  const { F } = await abis();
  return pubs[chainId].readContract({ address: FACTORY, abi: F, functionName: 'claimable', args: [who] }).catch(() => 0n);
}
export async function balanceOf(chainId, token, who) {
  if (!who) return 0n;
  return pubs[chainId].readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] }).catch(() => 0n);
}

export async function uploadMeta(fields) {
  const r = await fetch('/api/meta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || 'Upload failed');
  return j;
}

export function toWebp(file, size = 320) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(Error('Pick an image file'));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const x = c.getContext('2d'), s = Math.min(img.width, img.height);
      x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/webp', 0.9));
    };
    img.onerror = () => reject(Error('That image could not be read'));
    img.src = URL.createObjectURL(file);
  });
}
