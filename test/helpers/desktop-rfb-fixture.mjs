import { Duplex } from 'node:stream';
import { RfbInputGate } from '../../src/desktop-rfb-gate.mjs';
export function fixtureConsole() {
  let greeting = false,
    phase = 'version',
    buffer = Buffer.alloc(0),
    delivered = false;
  const stream = new Duplex({
    read() {
      if (!greeting) {
        greeting = true;
        this.push(Buffer.from('RFB 003.008\n'));
      }
    },
    write(chunk, encoding, done) {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length) {
          if (phase === 'version') {
            if (buffer.length < 12) break;
            buffer = buffer.subarray(12);
            this.push(Buffer.from([1, 1]));
            phase = 'security';
          } else if (phase === 'security') {
            buffer = buffer.subarray(1);
            this.push(Buffer.alloc(4));
            phase = 'init';
          } else if (phase === 'init') {
            buffer = buffer.subarray(1);
            const name = Buffer.from('Synthetic integration fixture'),
              init = Buffer.alloc(24 + name.length);
            init.writeUInt16BE(16, 0);
            init.writeUInt16BE(16, 2);
            init[4] = 32;
            init[5] = 24;
            init[7] = 1;
            init.writeUInt16BE(255, 8);
            init.writeUInt16BE(255, 10);
            init.writeUInt16BE(255, 12);
            init[14] = 16;
            init[15] = 8;
            init.writeUInt32BE(name.length, 20);
            name.copy(init, 24);
            this.push(init);
            phase = 'messages';
          } else {
            gate.push(buffer);
            buffer = Buffer.alloc(0);
          }
        }
        done();
      } catch (error) {
        done(error);
      }
    },
  });
  const gate = new RfbInputGate({
    canWrite: () => true,
    forward: message => {
      if (message[0] === 3 && !delivered) {
        delivered = true;
        const update = Buffer.alloc(16 + 16 * 16 * 4);
        update.writeUInt16BE(1, 2);
        update.writeUInt16BE(16, 8);
        update.writeUInt16BE(16, 10);
        for (let i = 16; i < update.length; i += 4) {
          update[i] = 40;
          update[i + 1] = 170;
          update[i + 2] = 60;
        }
        stream.push(update);
      }
    },
  });
  gate.phase = 'messages';
  return stream;
}
