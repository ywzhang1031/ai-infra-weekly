import test from 'node:test';
import assert from 'node:assert/strict';
import { readProduction } from './production-read.mjs';

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
