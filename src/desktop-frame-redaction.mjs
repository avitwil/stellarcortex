import { execFile } from 'node:child_process';
import { frameRedactionPlan } from './guest-redaction.mjs';
export function redactDesktopFrame(frame, selection, { run } = {}) {
  const bytes = Buffer.from(frame.image, 'base64');
  if (
    bytes.length > 8 * 1024 * 1024 ||
    frame.mimeType !== 'image/png' ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error('Bounded console PNG required');
  const args = frameRedactionPlan({ ...frame, ...selection });
  args[0] = 'png:-';
  args.unshift('-limit', 'memory', '128MiB', '-limit', 'map', '0', '-limit', 'time', '5');
  const convert =
    run ||
    ((args, input) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          '/usr/bin/convert',
          args,
          { encoding: null, maxBuffer: 4 * 1024 * 1024, timeout: 7000 },
          (error, out) =>
            error ? reject(Error('Visual redaction failed; no frame saved')) : resolve(out),
        );
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }));
  return Promise.resolve(convert(args, bytes)).then(output => ({
    image: Buffer.from(output).toString('base64'),
    mimeType: 'image/jpeg',
    width: selection.crop.width,
    height: selection.crop.height,
  }));
}
