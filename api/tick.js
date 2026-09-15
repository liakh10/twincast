/* Keeper (GitHub Actions cron with CRON_SECRET, or a page poke at most every 10 minutes).
   1. collect  fees of tokens with at least 0.001 ETH uncollected, on Robinhood Chain and Base
   2. buyback  on Robinhood Chain, once $TWIN trades in its Uniswap v4 pool, spend the buyback's ETH on $TWIN through
               the Universal Router; the buyback contract burns everything it receives in the same transaction
   The key is TWIN_OPERATOR_KEY; the same address pays gas on both chains and has to be the buyback keeper. */
import { createPublicClient, createWalletClient, http, fallback, parseAbi, parseEther, formatEther, encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, decodeFunctionResult, erc20Abi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redis } from '../lib/store.js';
import { json } from '../lib/http.js';

const CH = {
  4663: { rpc: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'], stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' },
  8453: { rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71' }
};
const chainOf = id => ({ id, name: 'chain ' + id, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: CH[id].rpc } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } });
const pubs = Object.fromEntries(Object.keys(CH).map(id => [id, createPublicClient({ chain: chainOf(Number(id)), transport: fallback(CH[id].rpc.map(u => http(u, { timeout: 15000 }))) })]));
const UR = '0x8876789976dEcBfCbBbe364623C63652db8C0904', PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const ZERO = '0x0000000000000000000000000000000000000000', OPEN = 207200, CAP = 207200 - 27800, MAX_TICK = 887200, Q128 = 1n << 128n, M256 = 1n << 256n;
const F = parseAbi(['function launchCount() view returns (uint256)', 'function launches(uint256,uint256) view returns ((address token,address creator,address feeTo,uint64 createdAt,uint256 ethFees,uint256 tokenBurned)[])', 'function collectFees(address) returns (uint256,uint256)']);
const SV = parseAbi(['function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)', 'function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns (uint128,uint256,uint256)']);
const BB = parseAbi(['function twin() view returns (address)', 'function keeper() view returns (address)', 'function allowedTarget(address) view returns (bool)', 'function buyBack(address,bytes,uint256,uint256) returns (uint256)']);
const PF = parseAbi(['function memeHook() view returns (address)', 'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const POOL_KEY = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const MIN_COLLECT = parseEther('0.001'), MIN_BUYBACK = parseEther('0.003'), BUDGET_MS = 45000;
const valid = v => /^0x[0-9a-fA-F]{40}$/.test(v || '') ? v : null;

async function siteConfig(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const origin = (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://') + host;
  const text = await fetch(origin + '/config.js', { cache: 'no-store' }).then(r => r.text()).catch(() => '');
  const pick = n => (text.match(new RegExp(n + '\\s*=\\s*"(0x[0-9a-fA-F]{40})"')) || [])[1] || null;
  return { factory: valid(process.env.TWIN_FACTORY) || pick('TWIN_FACTORY'), buyback: valid(process.env.TWIN_BUYBACK) || pick('TWIN_BUYBACK') };
}
function operator() {
  const key = process.env.TWIN_OPERATOR_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw Error('The keeper wallet is not configured yet.');
  const account = privateKeyToAccount(key);
  return { account, address: account.address, wallet: id => createWalletClient({ account, chain: chainOf(id), transport: http(CH[id].rpc[0], { timeout: 30000 }) }) };
}
async function sendTx(o, id, tx) {
  const hash = await o.wallet(id).sendTransaction({ account: o.account, chain: chainOf(id), ...tx });
  const rc = await pubs[id].waitForTransactionReceipt({ hash, timeout: 60000 });
  if (rc.status !== 'success') throw Error('Transaction reverted ' + hash);
  return hash;
}

async function collect(o, id, factory, started, log) {
  const pub = pubs[id];
  const n = Number(await pub.readContract({ address: factory, abi: F, functionName: 'launchCount' }).catch(() => 0n));
  if (!n) return;
  const list = await pub.readContract({ address: factory, abi: F, functionName: 'launches', args: [0n, 1000n] });
  const rows = list.map(l => ({ l, id: keccak256(encodeAbiParameters([POOL_KEY], [{ currency0: ZERO, currency1: l.token, fee: 10000, tickSpacing: 200, hooks: ZERO }])) }));
  const ranges = [[CAP, OPEN], [-MAX_TICK, CAP]];
  const res = await pub.multicall({ allowFailure: true, contracts: rows.flatMap(r => ranges.flatMap(([lo, hi]) => [{ address: CH[id].stateView, abi: SV, functionName: 'getFeeGrowthInside', args: [r.id, lo, hi] }, { address: CH[id].stateView, abi: SV, functionName: 'getPositionInfo', args: [r.id, factory, lo, hi, '0x' + '0'.repeat(64)] }])) });
  for (let i = 0; i < rows.length; i++) {
    let unc = 0n;
    for (let k = 0; k < 2; k++) { const inside = res[i * 4 + k * 2].result, pos = res[i * 4 + k * 2 + 1].result; if (inside && pos) unc += pos[0] * ((inside[0] - pos[1] + M256) % M256) / Q128; }
    if (unc < MIN_COLLECT) continue;
    if (Date.now() - started > BUDGET_MS) return log.push({ partial: id });
    const hash = await sendTx(o, id, { to: factory, data: encodeFunctionData({ abi: F, functionName: 'collectFees', args: [rows[i].l.token] }) });
    log.push({ chain: id, collected: rows[i].l.token, eth: formatEther(unc), tx: hash });
  }
}

function swapCalldata(key, amountIn, minOut) {
  const swap = encodeAbiParameters([{ type: 'tuple', components: [{ ...POOL_KEY, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }], [{ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ZERO, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency1, minOut]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]), [swap, settle, take]]);
  return encodeFunctionData({ abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']), functionName: 'execute', args: ['0x10', [input], BigInt(Math.floor(Date.now() / 1000) + 600)] });
}
async function rpc(req) {
  let last;
  for (const url of CH[4663].rpc) { try { return JSON.parse(await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })).text()); } catch (e) { last = e; } }
  throw Error('RPC unavailable: ' + (last && last.message));
}
async function buyback(o, bb, log) {
  const pub = pubs[4663];
  const [twin, keeper, allowed, balance] = await Promise.all([pub.readContract({ address: bb, abi: BB, functionName: 'twin' }), pub.readContract({ address: bb, abi: BB, functionName: 'keeper' }), pub.readContract({ address: bb, abi: BB, functionName: 'allowedTarget', args: [UR] }), pub.getBalance({ address: bb })]);
  if (twin === ZERO) return log.push({ buyback: 'waiting for $TWIN to be set on the buyback' });
  if (keeper.toLowerCase() !== o.address.toLowerCase()) return log.push({ buyback: 'the keeper wallet is not the buyback keeper' });
  if (!allowed) return log.push({ buyback: 'the Universal Router is not an allowed target' });
  if (balance < MIN_BUYBACK) return log.push({ buyback: 'under 0.003 ETH, waiting', balance: formatEther(balance) });
  const info = await pub.readContract({ address: PONS, abi: PF, functionName: 'getLaunchedToken', args: [twin] });
  if (!info.exists || info.phase !== 2) return log.push({ buyback: '$TWIN has not graduated to its Uniswap v4 pool yet' });
  const hook = await pub.readContract({ address: PONS, abi: PF, functionName: 'memeHook' });
  const key = { currency0: ZERO, currency1: twin, fee: info.poolFee, tickSpacing: info.tickSpacing, hooks: hook };
  const bal = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [bb] });
  const sim = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [{ from: bb, to: twin, data: bal }, { from: bb, to: UR, data: swapCalldata(key, balance, 0n), value: toHex(balance) }, { from: bb, to: twin, data: bal }] }], validation: false }, 'latest'] });
  const calls = sim.result && sim.result[0].calls;
  if (!calls || calls[1].status !== '0x1') return log.push({ buyback: 'quote failed' });
  const read = c => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: c.returnData });
  const out = read(calls[2]) - read(calls[0]), minOut = out * 97n / 100n;
  const hash = await sendTx(o, 4663, { to: bb, data: encodeFunctionData({ abi: BB, functionName: 'buyBack', args: [UR, swapCalldata(key, balance, minOut), balance, minOut] }) });
  log.push({ boughtAndBurned: formatEther(out), eth: formatEther(balance), tx: hash });
}

export default async function handler(req, res) {
  const R = redis(), q = req.query || {}, secret = process.env.CRON_SECRET;
  const authed = secret && (req.headers.authorization === 'Bearer ' + secret || q.secret === secret);
  if (!authed && !(await R.set('tw:poke', '1', { nx: true, ex: 600 }))) return json(res, 200, { ok: true, skipped: 'recent run' });
  let o;
  try { o = operator(); } catch (e) { return json(res, 200, { ok: false, skipped: e.message }); }
  const cfg = await siteConfig(req);
  if (!cfg.factory) return json(res, 200, { ok: false, skipped: 'contracts are not in config.js yet' });
  const lock = Math.random().toString(36).slice(2);
  if (!(await R.set('tw:lock:keeper', lock, { nx: true, px: 58000 }))) return json(res, 200, { ok: true, skipped: 'keeper busy' });
  const log = [], started = Date.now();
  try {
    for (const id of [4663, 8453]) await collect(o, id, cfg.factory, started, log).catch(e => log.push({ chain: id, collectError: e.shortMessage || e.message }));
    if (cfg.buyback) await buyback(o, cfg.buyback, log).catch(e => log.push({ buybackError: e.shortMessage || e.message }));
    json(res, 200, { ok: true, log });
  } finally {
    if ((await R.get('tw:lock:keeper')) === lock) await R.del('tw:lock:keeper');
  }
}
