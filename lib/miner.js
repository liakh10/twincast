/* Web worker: searches for a launch salt whose token address ends in the Twincast suffix. The address depends only on
   the factory, the launcher, the salt and the token creation code, so the same salt works on both chains. */
import { keccak256, concat, pad, toHex } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';

onmessage = e => {
  const { factory, launcher, codeHash, suffix, start } = e.data;
  const want = suffix.toLowerCase();
  const who = pad(launcher.toLowerCase(), { size: 32 });
  const head = concat(['0xff', factory.toLowerCase()]);
  let i = BigInt(start);
  for (let n = 1; n < 5_000_000; n++, i++) {
    const userSalt = pad(toHex(i), { size: 32 });
    const salt = keccak256(concat([who, userSalt]));
    const h = keccak256(concat([head, salt, codeHash]));
    if (h.endsWith(want)) { postMessage({ userSalt, address: '0x' + h.slice(-40), tries: n }); return; }
    if (n % 4000 === 0) postMessage({ progress: n });
  }
  postMessage({ error: 'No address found, try again' });
};
