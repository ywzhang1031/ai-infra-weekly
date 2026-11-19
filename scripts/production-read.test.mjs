import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { readProduction, readProductionBatch } from './production-read.mjs';

const url = 'https://weekly.example.org/weeks/2026-11-16/';
function reply({ status = 0, http = 200, body = 'complete body', ssl = 0, timings = ['0.0001', '0.0003', '0.9', '1.0', '1.1'] } = {}) {
  return { status, signal: null, stderr: Buffer.from('credential-like-sensitive-stderr'),
    stdout: Buffer.concat([Buffer.from(body), Buffer.from(`\n__INFRA_PRODUCTION_READ__\t${String(http).padStart(3, '0')}\t${timings.join('\t')}\t${ssl}\n`)]) };
}
function runner(results) {
  const calls = [];
  return { calls, run: (...args) => {
    calls.push(args);
    assert.ok(results.length, 'No unbounded retries');
    return results.shift();
  } };
}

test('one fresh GET retries an unfinished TLS timeout with ssl_verify_result=1 and discards its partial body', () => {
  const { run, calls } = runner([
    reply({ status: 28, http: 0, ssl: 1, body: 'partial bytes from failed attempt', timings: ['0.0001', '0.000293', '0', '0', '5.006781'] }),
    reply({ body: 'fresh successful body' }),
  ]);
  assert.equal(readProduction(url, { run }).toString(), 'fresh successful body');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0][1], calls[1][1]);
  for (const [executable, args, options] of calls) {
    assert.equal(executable, 'curl');
    assert.equal(args[0], '--disable');
    for (const [flag, value] of [['--proto', '=https'], ['--request', 'GET'], ['--connect-timeout', '10'], ['--max-time', '20'], ['--max-filesize', '2097152'], ['--retry', '0']]) {
      assert.equal(args[args.indexOf(flag) + 1], value);
    }
    assert.equal(options.timeout, 25_000);
    assert.equal(options.env, undefined, 'Keep the existing proxy and CA environment');
    assert.ok(!args.includes('--insecure') && !args.includes('-k') && !args.includes('--noproxy'));
  }
});

test('consecutive timeouts stop after two attempts with safe stage and timing diagnostics', () => {
  const timeout = { status: 28, http: 0, ssl: 1, timings: ['0.0001', '0.000293', '0', '0', '5.006781'] };
  const { run, calls } = runner([reply(timeout), reply(timeout)]);
  assert.throws(() => readProduction(url, { run }), error => {
    assert.equal(calls.length, 2);
    assert.equal(error.attempts.length, 2);
    assert.equal(error.attempts[0].phase, 'tls_handshake');
    assert.equal(error.attempts[1].phase, 'tls_handshake');
    assert.equal(error.attempts[1].curlExit, 28);
    assert.equal(error.attempts[1].timingsSeconds.connect, 0.000293);
    assert.equal(error.attempts[1].timingsSeconds.total, 5.006781);
    assert.match(error.message, /after 2 attempt\(s\)/);
    assert.doesNotMatch(error.message, /credential-like|stderr|https:\/\//);
    return true;
  });
});

test('certificate errors and non-200 HTTP responses never retry', () => {
  for (const response of [reply({ status: 60, ssl: 60 }), reply({ status: 0, ssl: 60 }),
    reply({ status: 60, http: 0, ssl: 1, timings: ['0', '0.000293', '0', '0', '5.006781'] }),
    reply({ status: 51, http: 0, ssl: 1, timings: ['0', '0.000293', '0', '0', '5.006781'] }),
    reply({ status: 28, http: 0, ssl: 1 }), reply({ status: 0, ssl: 1 }),
    reply({ status: 22, http: 503 }), reply({ status: 0, http: 301 }), reply({ status: 28, http: 503 })]) {
    const { run, calls } = runner([response]);
    assert.throws(() => readProduction(url, { run }), /after 1 attempt/);
    assert.equal(calls.length, 1);
  }
});

test('process, transport, missing metadata and size failures do not trigger timeout retries', () => {
  for (const response of [reply({ status: 35 }), { status: null, error: { code: 'ETIMEDOUT' }, stdout: Buffer.from('partial secret') },
    { status: 0, stdout: Buffer.from('missing trailer') }, reply({ body: Buffer.alloc(2 * 1024 * 1024 + 1) })]) {
    const { run, calls } = runner([response]);
    assert.throws(() => readProduction(url, { run }));
    assert.equal(calls.length, 1);
  }
});

test('returns unmodified binary body and rejects non-HTTPS or credential URLs before running curl', () => {
  const body = Buffer.from([0, 10, 255, 13, 1]);
  const { run, calls } = runner([reply({ body })]);
  assert.deepEqual(readProduction(url, { run }), body);
  for (const invalid of ['http://weekly.example.org/', 'https://secret:password@weekly.example.org/', 'not a url']) {
    assert.throws(() => readProduction(invalid, { run }), /HTTPS/);
  }
  assert.equal(calls.length, 1);
});


function batchLine(index, { http = 200, exit = 0, ssl = 0, connections = index ? 0 : 1, connectionId = 0, connect = 0.002, tls = index ? 0 : 0.9, firstByte = http ? 1 : 0 } = {}) {
  return `__INFRA_PRODUCTION_BATCH__\t${index}\t${http}\t${exit}\t0.001\t${connect}\t${tls}\t${firstByte}\t1.1\t${ssl}\t${connections}\t${connectionId}\n`;
}
function outputs(args) { return args.flatMap((arg, index) => arg === '--output' ? [args[index + 1]] : []); }

test('batch reuses one process and keeps independent binary bodies with verified metadata', () => {
  let calls = 0;
  let files;
  const bodies = [Buffer.from([0, 255, 10]), Buffer.from('second response')];
  const result = readProductionBatch([url, 'https://weekly.example.org/favicon.svg'], { run: (bin, args, options) => {
    calls += 1;
    assert.equal(bin, 'curl');
    assert.ok(args.includes('--fail-early') && args.includes('--globoff'));
    assert.ok(!args.includes('--insecure') && !args.includes('--location') && !args.includes('--noproxy'));
    assert.equal(options.env, undefined);
    files = outputs(args);
    assert.equal(files.length, 2);
    files.forEach((file, index) => writeFileSync(file, bodies[index]));
    return { status: 0, stdout: batchLine(0) + batchLine(1) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.map(value => value.body), bodies);
  assert.equal(result.reduce((sum, value) => sum + value.transport.newConnections, 0), 1);
  assert.ok(files.every(file => !existsSync(file)), 'Temporary response files are removed');
});

test('batch discards partial response files and retries only once after a TLS timeout', () => {
  const seen = [];
  const result = readProductionBatch([url], { run: (_bin, args) => {
    const file = outputs(args)[0]; seen.push(file);
    writeFileSync(file, seen.length === 1 ? 'partial unsafe bytes' : 'complete body');
    return seen.length === 1
      ? { status: 28, stdout: batchLine(0, { http: 0, exit: 28, ssl: 1, tls: 0, connections: 0, connectionId: -1 }) }
      : { status: 0, stdout: batchLine(0) };
  } });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(result[0].body.toString(), 'complete body');
  assert.equal(result[0].transport.attempt, 2);
  assert.ok(seen.every(file => !existsSync(file)));
});

test('batch rejects incomplete, duplicated, invalid, certificate and HTTP results without retry', () => {
  const responses = [
    { status: 0, stdout: batchLine(0) },
    { status: 0, stdout: batchLine(0) + batchLine(0) },
    { status: 0, stdout: 'unknown metadata' },
    { status: 60, stdout: batchLine(0, { http: 0, exit: 60, ssl: 60, tls: 0 }) },
    { status: 22, stdout: batchLine(0, { http: 503, exit: 22 }) },
    { status: 0, stdout: batchLine(0, { ssl: 1 }) + batchLine(1) },
    { status: 28, stdout: batchLine(0, { exit: 28, http: 0, ssl: 1, tls: 0.8 }) },
    { status: null, error: { code: 'ETIMEDOUT' }, stdout: '' },
  ];
  for (const response of responses) {
    let calls = 0;
    assert.throws(() => readProductionBatch([url, 'https://weekly.example.org/'], { run: () => { calls += 1; return { ...response, stderr: 'do not leak secret details' }; } }), error => {
      assert.doesNotMatch(error.message, /secret details/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('batch timeout budget is bounded and oversized bodies cannot pass', () => {
  let calls = 0;
  assert.throws(() => readProductionBatch([url], { run: () => {
    calls += 1;
    return { status: 28, stdout: batchLine(0, { http: 0, exit: 28, ssl: 1, tls: 0 }) };
  } }), error => error.attempts.length === 2);
  assert.equal(calls, 2);
  assert.throws(() => readProductionBatch([url], { run: (_bin, args) => {
    writeFileSync(outputs(args)[0], Buffer.alloc(2 * 1024 * 1024 + 1));
    return { status: 0, stdout: batchLine(0) };
  } }), /size limit/);
  for (const invalid of [[], [url, url], [url, 'https://different.example.org/'], ['http://example.org'], ['https://secret:password@example.org/'], Array(65).fill(url)]) {
    assert.throws(() => readProductionBatch(invalid, { run: () => { throw new Error('Must not call curl'); } }), error => !error.message.includes('Must not call'));
  }
});

test('timeouts on a reused connection distinguish response headers and body from TLS', () => {
  for (const [http, phase] of [[0, 'response_headers'], [200, 'response_body']]) {
    assert.throws(() => readProductionBatch([url, 'https://weekly.example.org/'], { run: () => ({
      status: 28, stdout: batchLine(0) + batchLine(1, { http, exit: 28, connect: 0, tls: 0 }),
    }) }), error => error.attempts.length === 2 && error.attempts.every(attempt => attempt.phase === phase));
  }
});
