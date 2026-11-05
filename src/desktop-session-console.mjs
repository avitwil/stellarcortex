import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { sessionEnvelope } from './desktop-session-registration.mjs';
import { scopeKey } from './desktop-provider-session.mjs';
export function connectSessionConsole(
  record,
  {
    spawnImpl = spawn,
    helper = '/opt/stellarcortex-desktop-broker/scripts/desktop-session-console.py',
  } = {},
) {
  const envelope = sessionEnvelope(record, record, 'display');
  const child = spawnImpl('/usr/bin/python3', ['-I', helper, String(record.cid)], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  let ready = false,
    header = Buffer.alloc(0),
    timer;
  const stream = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(bytes, _encoding, done) {
      child.stdin.write(bytes, done);
    },
    final(done) {
      child.stdin.end(done);
    },
    destroy(error, done) {
      clearTimeout(timer);
      child.kill('SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
      done(error);
    },
  });
  timer = setTimeout(() => stream.destroy(Error('Session display connection timed out')), 12000);
  timer.unref();
  child.on('error', () => stream.destroy(Error('Session display transport could not start')));
  child.on('close', code => {
    if (!ready || code !== 0) stream.destroy(Error('Session display transport closed'));
    else stream.push(null);
  });
  child.stdin.on('error', () => stream.destroy(Error('Session display input closed')));
  child.stdout.on('data', bytes => {
    try {
      if (!ready) {
        header = Buffer.concat([header, bytes]);
        const newline = header.indexOf(10);
        if (newline < 0) {
          if (header.length > 4096) throw Error('Invalid session display handshake');
          return;
        }
        if (newline > 4096) throw Error('Invalid session display handshake');
        const reply = JSON.parse(header.subarray(0, newline).toString());
        if (reply.ready !== true || scopeKey(reply.scope) !== scopeKey(record))
          throw Error('Session display identity mismatch');
        bytes = header.subarray(newline + 1);
        header = null;
        ready = true;
        clearTimeout(timer);
        stream.emit('connect');
      }
      if (bytes.length && !stream.push(bytes)) child.stdout.pause();
    } catch (error) {
      stream.destroy(error);
    }
  });
  child.stdin.write(JSON.stringify(envelope) + '\n');
  return stream;
}
