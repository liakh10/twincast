/* Runs Twincast against forks of Robinhood Chain and Base mainnet at the same time (ethereumjs VM + RPCStateManager):
   the real CREATE2 deployer, Uniswap v4 PoolManager and StateView on both chains, and on Robinhood Chain the Universal
   Router with a graduated Pons token standing in for $TWIN in the buyback. The point of the suite is that the factory,
   the router and every token land on the same address on both chains. No keys are involved. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { Common, Hardfork } from '@ethereumjs/common';
import { Block } from '@ethereumjs/block';
import { Address, Account, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, encodeDeployData, encodeAbiParameters, encodePacked, keccak256, parseAbi, formatEther, getAddress, concat, toBytes } from 'viem';

const RPCS = { robinhood: 'https://robinhood-rpc.publicnode.com', base: 'https://base-rpc.publicnode.com' };
const realFetch = globalThis.fetch;
let rpcRetries = 0;
globalThis.fetch = async (url, opts) => {
  if (!Object.values(RPCS).some(r => String(url).startsWith(r))) return realFetch(url, opts);
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      const text = await (await realFetch(url, opts)).text();
      const j = JSON.parse(text);
      if (j.result !== undefined) return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
      last = JSON.stringify(j.error || j);
    } catch (e) { last = e.message; }
    rpcRetries++;
    await new Promise(r => setTimeout(r, 250 * 2 ** i));
  }
  throw Error('RPC failed after retries: ' + last);
};

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const TOKEN = art('TwinToken'), FACTORY = art('TwinFactory'), ROUTER = art('TwinRouter'), BUYBACK = art('TwinBuyback');
const ALL = [...TOKEN.abi, ...FACTORY.abi, ...ROUTER.abi, ...BUYBACK.abi].filter((x, i, a) => x.type !== 'event' || a.findIndex(y => y.type === 'event' && y.name === x.name) === i);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const SV = parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)']);
const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const CHAINS = {
  robinhood: { id: 4663, poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904' },
  base: { id: 8453, poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b', stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71' }
};
export const SALTS = { factory: keccak256(toBytes('twincast.factory.v1')), router: keccak256(toBytes('twincast.router.v1')) };
const PONS_TOKEN = '0xCc50404bd4219245eaE40415D6BAb679180f7F7E', PONS_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const DEAD = '0x000000000000000000000000000000000000dEaD', ZERO = '0x0000000000000000000000000000000000000000';
const E = n => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const POOL_KEY = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const poolId = k => keccak256(encodeAbiParameters([POOL_KEY], [k]));

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL', label, extra); } };

class ForkState extends RPCStateManager {
  constructor(o) { super(o); this._codeStack = []; }
  async checkpoint() { await super.checkpoint(); this._codeStack.push(new Map(this._contractCache)); }
  async commit() { this._accountCache.commit(); this._storageCache.commit(); this._codeStack.pop(); }
  async revert() { this._accountCache.revert(); this._storageCache.revert(); const snap = this._codeStack.pop(); if (snap) this._contractCache = snap; }
}

async function fork(name) {
  const url = RPCS[name], C = CHAINS[name];
  const head = (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })).json()).result;
  const common = Common.custom({ chainId: C.id, networkId: C.id }, { hardfork: Hardfork.Cancun });
  const stateManager = new ForkState({ provider: url, blockTag: BigInt(head.number) });
  stateManager._blockTag = 'latest';
  const vm = await VM.create({ common, stateManager });
  const now = BigInt(Math.floor(Date.now() / 1000)) + 600n;
  const block = () => Block.fromBlockData({ header: { number: BigInt(head.number) + 1n, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });
  const f = { name, C, head: Number(head.number), now };
  f.exec = async (from, to, data, value = 0n) => {
    const r = await vm.evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), gasLimit: 30_000_000n, value, block: block() });
    const e = r.execResult;
    let reason = null;
    if (e.exceptionError) { try { const d = decodeErrorResult({ abi: ALL, data: bytesToHex(e.returnValue) }); reason = d.args ? String(d.args[0]) : d.errorName; } catch { reason = e.exceptionError.error + ' ' + bytesToHex(e.returnValue); } }
    const logs = (e.logs || []).map(([a, topics, d]) => { try { return { address: getAddress(bytesToHex(a)), ...decodeEventLog({ abi: ALL, topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
    return { reverted: !!e.exceptionError, reason, logs, ret: bytesToHex(e.returnValue), gas: e.executionGasUsed };
  };
  f.tx = async (from, to, abi, functionName, args = [], value = 0n) => {
    const r = await f.exec(from, to, encodeFunctionData({ abi, functionName, args }), value);
    if (!r.reverted) try { r.result = decodeFunctionResult({ abi, functionName, data: r.ret }); } catch {}
    return r;
  };
  f.must = async (from, to, abi, fn, args = [], label = fn, value = 0n) => {
    const r = await f.tx(from, to, abi, fn, args, value);
    ok(!r.reverted, `[${name}] ${label}`, r.reason || '');
    return r;
  };
  f.reverts = async (from, to, abi, fn, args, expect, label, value = 0n) => {
    const r = await f.tx(from, to, abi, fn, args, value);
    ok(r.reverted && (!expect || String(r.reason).includes(expect)), `[${name}] ${label}`, `reverted=${r.reverted} reason=${r.reason}`);
  };
  f.view = async (to, abi, fn, args = []) => {
    const r = await f.tx(addr(1), to, abi, fn, args);
    if (r.reverted) throw Error(`[${name}] ${fn} reverted: ${r.reason}`);
    return r.result;
  };
  f.bal = (token, who) => f.view(token, ERC20, 'balanceOf', [who]);
  f.ethBal = async who => (await vm.stateManager.getAccount(Address.fromString(who)))?.balance ?? 0n;
  f.giveEth = async (who, wei) => { const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account(); acct.balance = wei; await vm.stateManager.putAccount(a, acct); };
  f.bump = async who => { const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account(); acct.nonce += 1n; await vm.stateManager.putAccount(a, acct); };
  f.create2 = async (from, salt, initcode) => {
    const r = await f.exec(from, CREATE2_PROXY, concat([salt, initcode]));
    if (r.reverted || r.ret.length < 42) throw Error(`[${name}] CREATE2 deploy failed ${r.reason}`);
    return getAddress('0x' + r.ret.slice(-40));
  };
  f.deploy = async (from, a, args = []) => {
    const r = await vm.evm.runCall({ caller: Address.fromString(from), data: hexToBytes(args.length ? encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) : a.bytecode), gasLimit: 30_000_000n, block: block() });
    if (r.execResult.exceptionError) throw Error('deploy failed ' + a.contractName);
    await f.bump(from);
    return getAddress(r.createdAddress.toString());
  };
  f.mcapEth = async (factory, token) => {
    const key = await f.view(factory, FACTORY.abi, 'poolKeyOf', [token]);
    const [sqrt, tick] = await f.view(C.stateView, SV, 'getSlot0', [poolId(key)]);
    const s = Number(sqrt) / 2 ** 96;
    return { eth: 1e9 / (s * s), tick };
  };
  return f;
}

const owner = addr(0xd0), alice = addr(0xa1), bob = addr(0xb0), carol = addr(0xc0), eve = addr(0xee), whale = addr(0x3a1e), treasury = addr(0x7e), keeper = addr(0x6e);
const factoryInit = encodeDeployData({ abi: FACTORY.abi, bytecode: FACTORY.bytecode, args: [owner] });
const userSalt = '0x' + '00'.repeat(31) + '2a';
const META = ['Twin Cat', 'TCAT', 'https://twincast.example/meta/twin-cat'];
const RH = await fork('robinhood'), BA = await fork('base');
console.log(`forks: robinhood block ${RH.head}, base block ${BA.head}`);
console.log(`  sizes: factory ${FACTORY.deployedSize}, router ${ROUTER.deployedSize}, token ${TOKEN.deployedSize}, buyback ${BUYBACK.deployedSize}`);

const out = {};
for (const f of [RH, BA]) {
  const F = await f.create2(eve, SALTS.factory, factoryInit);
  const R = await f.create2(eve, SALTS.router, encodeDeployData({ abi: ROUTER.abi, bytecode: ROUTER.bytecode, args: [F] }));
  out[f.name] = { F, R };
}
console.log(`  factory ${out.robinhood.F} / ${out.base.F} · router ${out.robinhood.R} / ${out.base.R}`);
ok(out.robinhood.F === out.base.F, 'factory has the same address on both chains');
ok(out.robinhood.R === out.base.R, 'router has the same address on both chains');
const F = out.robinhood.F, R = out.robinhood.R;
const B = await RH.deploy(owner, BUYBACK);

const tokens = {};
for (const f of [RH, BA]) {
  const n = f.name, recipient = n === 'robinhood' ? B : treasury;
  await f.reverts(alice, F, FACTORY.abi, 'launch', [...META, userSalt, 0n], 'not configured', 'launch needs configure');
  await f.reverts(eve, F, FACTORY.abi, 'configure', [f.C.poolManager, R, recipient], 'owner', 'configure only owner');
  await f.must(owner, F, FACTORY.abi, 'configure', [f.C.poolManager, R, recipient], 'owner configures');
  await f.reverts(owner, F, FACTORY.abi, 'configure', [f.C.poolManager, R, recipient], 'configured', 'configure only once');
  for (const w of [alice, bob, carol, eve, whale, keeper]) await f.giveEth(w, E(10));
  await f.giveEth(whale, E(30));

  const predicted = await f.view(F, FACTORY.abi, 'predictToken', [alice, userSalt, ...META]);
  const bobPredicted = await f.view(F, FACTORY.abi, 'predictToken', [bob, userSalt, ...META]);
  ok(predicted !== bobPredicted, `[${n}] another launcher gets another address for the same salt`);
  const la = await f.must(alice, F, FACTORY.abi, 'launch', [...META, userSalt, 0n], 'alice launches with a 0.05 ETH first buy', E(0.05));
  const ev = la.logs.find(l => l.eventName === 'TokenLaunched').args;
  const T = ev.token;
  tokens[n] = T;
  console.log(`  [${n}] launch gas ${la.gas} · token ${T}`);
  ok(T === predicted, `[${n}] token lands on the predicted address`);
  ok(ev.devTokens > 0n && (await f.bal(T, alice)) === ev.devTokens, `[${n}] first buy landed`, formatEther(ev.devTokens));
  ok((await f.bal(T, F)) === 0n && (await f.bal(T, DEAD)) < 10n ** 9n, `[${n}] factory keeps no tokens, only dust burned`);
  ok((await f.bal(T, f.C.poolManager)) + ev.devTokens + (await f.bal(T, DEAD)) === 10n ** 27n, `[${n}] whole supply in the pool or with alice`);
  ok((await f.view(T, TOKEN.abi, 'router')) === R && (await f.view(T, TOKEN.abi, 'creator')) === alice && (await f.view(T, TOKEN.abi, 'factory')) === F, `[${n}] token fields`);
  await f.reverts(alice, F, FACTORY.abi, 'launch', [...META, userSalt, 0n], '', 'the same launch cannot happen twice');
  await f.reverts(alice, F, FACTORY.abi, 'launch', ['Bad', 'B', 'u', '0x' + '11'.repeat(32), 0n], 'text', 'ticker needs 2 letters');

  const plain = await f.must(bob, F, FACTORY.abi, 'launch', ['Plain', 'PLN', 'u', userSalt, 0n], 'bob launches without a buy');
  const mc = await f.mcapEth(F, plain.logs.find(l => l.eventName === 'TokenLaunched').args.token);
  ok(Math.abs(mc.eth / 1.0043 - 1) < 0.001, `[${n}] opening market cap 1 ETH`, mc.eth.toFixed(4));

  const b1 = await f.must(bob, R, ROUTER.abi, 'buy', [T, 0n, bob], 'bob buys with 0.3 ETH', E(0.3));
  const bobTok = await f.bal(T, bob);
  ok(bobTok > 0n, `[${n}] bob got tokens`);
  await f.reverts(bob, R, ROUTER.abi, 'buy', [T, 10n ** 30n, bob], 'min out', 'minOut guard on buys', E(0.01));
  await f.reverts(bob, R, ROUTER.abi, 'buy', [addr(0x1234), 0n, bob], 'token', 'router refuses unknown tokens', E(0.01));
  const e0 = await f.ethBal(bob);
  await f.reverts(bob, R, ROUTER.abi, 'sell', [T, bobTok / 2n, 10n ** 30n, bob], 'min out', 'minOut guard on sells');
  const s1 = await f.must(bob, R, ROUTER.abi, 'sell', [T, bobTok / 2n, 0n, bob], 'bob sells half without approval');
  ok((await f.ethBal(bob)) > e0, `[${n}] bob got ETH back`);
  console.log(`  [${n}] buy gas ${b1.gas} · sell gas ${s1.gas}`);

  const r0 = await f.ethBal(recipient), a0 = await f.view(F, FACTORY.abi, 'claimable', [alice]), d0 = await f.bal(T, DEAD);
  const c1 = await f.must(eve, F, FACTORY.abi, 'collectFees', [T], 'anyone collects fees');
  const fe = c1.logs.find(l => l.eventName === 'FeesCollected').args;
  ok(fe.ethFees > 0n && fe.tokenBurned > 0n && fe.toCreator === fe.ethFees / 2n && fe.toProtocol === fe.ethFees - fe.toCreator, `[${n}] fees split 50 / 50`, formatEther(fe.ethFees));
  const expected = (E(0.05) + E(0.3)) / 100n;
  const diff = fe.ethFees > expected ? fe.ethFees - expected : expected - fe.ethFees;
  ok(diff * 1000n <= expected, `[${n}] ETH fees are 1% of ETH bought`);
  ok((await f.ethBal(recipient)) - r0 === fe.toProtocol, `[${n}] protocol share sent to ${n === 'robinhood' ? 'the buyback' : 'the treasury'}`);
  ok((await f.view(F, FACTORY.abi, 'claimable', [alice])) - a0 === fe.toCreator && (await f.bal(T, DEAD)) - d0 === fe.tokenBurned, `[${n}] creator accrued, token fees burned`);

  await f.reverts(bob, F, FACTORY.abi, 'setFeeTo', [T, bob], 'creator', 'only the creator redirects fees');
  await f.must(alice, F, FACTORY.abi, 'setFeeTo', [T, carol], 'alice sends future fees to carol');
  await f.must(bob, R, ROUTER.abi, 'buy', [T, 0n, bob], 'bob buys again', E(0.2));
  const c0 = await f.view(F, FACTORY.abi, 'claimable', [carol]);
  await f.must(eve, F, FACTORY.abi, 'collectFees', [T], 'collect after redirect');
  ok((await f.view(F, FACTORY.abi, 'claimable', [carol])) > c0, `[${n}] redirected fees reach carol`);

  const owed = await f.view(F, FACTORY.abi, 'claimable', [alice]), ea = await f.ethBal(alice);
  await f.must(alice, F, FACTORY.abi, 'claim', [], 'alice claims');
  ok((await f.ethBal(alice)) - ea === owed && owed > 0n, `[${n}] alice paid exactly`);
  const owedC = await f.view(F, FACTORY.abi, 'claimable', [carol]), ec = await f.ethBal(carol);
  await f.must(eve, F, FACTORY.abi, 'claimFor', [carol], 'eve pushes carol claim');
  ok((await f.ethBal(carol)) - ec === owedC, `[${n}] carol paid`);

  const before = await f.mcapEth(F, T);
  await f.must(whale, R, ROUTER.abi, 'buy', [T, 0n, whale], 'whale buys with 4 ETH', E(4));
  const after = await f.mcapEth(F, T);
  ok(after.tick < 207200 - 27800 && after.eth > 16, `[${n}] price passed the curve`, `${before.eth.toFixed(2)} -> ${after.eth.toFixed(2)} ETH`);
  const wt = await f.bal(T, whale), ew = await f.ethBal(whale);
  await f.must(whale, R, ROUTER.abi, 'sell', [T, wt, 0n, whale], 'whale sells back');
  const back = (await f.ethBal(whale)) - ew;
  ok(back < E(4) && back > E(3.85), `[${n}] whale gets back 4 ETH minus about 2%`, formatEther(back));

  await f.reverts(eve, F, FACTORY.abi, 'unlockCallback', ['0x'], 'pool manager', 'factory callback only from PoolManager');
  await f.reverts(eve, R, ROUTER.abi, 'unlockCallback', ['0x'], 'pool manager', 'router callback only from PoolManager');
  ok((await f.exec(eve, F, '0x', E(0.01))).reverted, `[${n}] factory refuses plain ETH`);
}
ok(tokens.robinhood === tokens.base, 'Twin Cat has the same address on Robinhood Chain and Base', `${tokens.robinhood} / ${tokens.base}`);
ok(!FACTORY.abi.some(x => x.type === 'function' && /remove|withdraw|decrease|migrate|setRouter|setProtocol/i.test(x.name)), 'factory has no liquidity removal and no admin setters');
ok(!BUYBACK.abi.some(x => x.type === 'function' && /withdraw|sweep|rescue/i.test(x.name)), 'buyback has no withdraw');

// ------------------------------------------------------------------ buyback on Robinhood Chain with a graduated Pons token
{
  const f = RH;
  await f.must(owner, B, BUYBACK.abi, 'setKeeper', [keeper]);
  await f.must(owner, B, BUYBACK.abi, 'setTwin', [PONS_TOKEN], 'set $TWIN stand-in');
  await f.reverts(keeper, B, BUYBACK.abi, 'buyBack', [f.C.universalRouter, '0x', 1n, 0n], 'target', 'target must be allowed');
  await f.must(owner, B, BUYBACK.abi, 'setTarget', [f.C.universalRouter, true]);
  const have = await f.ethBal(B);
  const key = { currency0: ZERO, currency1: PONS_TOKEN, fee: 0, tickSpacing: 200, hooks: PONS_HOOK };
  const swap = encodeAbiParameters([{ type: 'tuple', components: [{ ...POOL_KEY, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }], [{ poolKey: key, zeroForOne: true, amountIn: have, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: '0x' }]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ZERO, have]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [PONS_TOKEN, 0n]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]), [swap, settle, take]]);
  const data = encodeFunctionData({ abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']), functionName: 'execute', args: ['0x10', [input], f.now + 600n] });
  const dead0 = await f.bal(PONS_TOKEN, DEAD);
  const r = await f.must(keeper, B, BUYBACK.abi, 'buyBack', [f.C.universalRouter, data, have, 1n], 'keeper buys back and burns');
  const got = r.logs.find(l => l.eventName === 'BoughtBack');
  ok(have > 0n && got && (await f.bal(PONS_TOKEN, DEAD)) - dead0 === got.args.twinOut, 'everything bought was burned', got && formatEther(got.args.twinOut));
}

console.log(`\n${pass} passed, ${fail} failed · rpc retries ${rpcRetries}`);
process.exit(fail ? 1 : 0);
