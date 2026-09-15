process.env.TWIN_MEMORY = '1';
const H = { meta: (await import('./api/meta.js')).default, img: (await import('./api/img.js')).default, tick: (await import('./api/tick.js')).default };
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
async function call(n, method, query = {}, body) { let out = ''; const headers = {}; const res = { statusCode: 200, setHeader(k, v) { headers[k] = v; }, end(s) { out = s; } }; await H[n]({ method, query, body: body ? JSON.stringify(body) : '', headers: { host: 'localhost:1' } }, res); let j = null; try { j = JSON.parse(out); } catch {} return { code: res.statusCode, j, headers }; }
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let r = await call('meta', 'POST', {}, { name: 'Twin Cat', symbol: 'tcat', description: 'x', image: png });
ok(r.code === 200 && r.j.meta.symbol === 'TCAT' && /\/api\/meta\?id=/.test(r.j.uri), 'meta stored');
const id = r.j.uri.split('id=')[1];
r = await call('meta', 'GET', { id }); ok(r.code === 200 && r.j.name === 'Twin Cat', 'meta served');
r = await call('img', 'GET', { id }); ok(r.code === 200 && r.headers['content-type'] === 'image/png', 'logo served');
r = await call('tick', 'GET', {}); ok(r.j && r.j.ok === false && /keeper wallet/.test(r.j.skipped), 'keeper skips without key');
console.log(`api ${pass}/${fail}`); process.exit(fail ? 1 : 0);
