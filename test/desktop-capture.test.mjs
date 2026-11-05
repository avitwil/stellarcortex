import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLibvirtConsole } from '../src/desktop-capture.mjs';
test('console capture uses a generated private destination and removes it after success or malformed data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scx-capture-test-'));
  let args;
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  try {
    const result = await captureLibvirtConsole({
      uuid: 'registered',
      directory,
      run: async a => {
        args = a;
        await writeFile(a[2], png);
      },
    });
    assert.equal(result.width, 1280);
    assert.equal(result.height, 800);
    assert.equal(args[0], 'screenshot');
    assert.equal(args[1], 'registered');
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(
      captureLibvirtConsole({
        uuid: 'registered',
        directory,
        run: async a => writeFile(a[2], 'invalid'),
      }),
      /Invalid/,
    );
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(
      captureLibvirtConsole({
        uuid: 'registered',
        directory,
        run: async () => {
          throw Error('disconnected');
        },
      }),
      /disconnected/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
