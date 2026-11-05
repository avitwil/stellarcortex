// RFB 3.8 client-stream parser for a private QEMU Unix console configured with
// SecurityType None. Public authentication is enforced by the HTTPS gateway.
// Framebuffer reads continue without control; input is checked per message.
export class RfbInputGate {
  constructor({
    canWrite,
    forward,
    onRejected = () => {},
    onForwarded = () => {},
    maxBuffered = 1024 * 1024,
  }) {
    Object.assign(this, { canWrite, forward, onRejected, onForwarded, maxBuffered });
    this.buffer = Buffer.alloc(0);
    this.phase = 'version';
  }
  push(chunk) {
    if (this.buffer.length + chunk.length > this.maxBuffered)
      throw Error('RFB input exceeds bounded buffer');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      if (this.phase === 'version') {
        if (this.buffer.length < 12) return;
        const v = this.take(12);
        if (v.toString() !== 'RFB 003.008\n') throw Error('RFB 3.8 required');
        this.forward(v);
        this.phase = 'security';
        continue;
      }
      if (this.phase === 'security') {
        if (this.take(1)[0] !== 1) throw Error('Unexpected private console security negotiation');
        this.forward(Buffer.from([1]));
        this.phase = 'init';
        continue;
      }
      if (this.phase === 'init') {
        this.take(1);
        this.forward(Buffer.from([1]));
        this.phase = 'messages';
        continue;
      } // Force shared viewer semantics.
      const b = this.buffer,
        type = b[0];
      let length,
        write = false;
      if (type === 0)
        length = 20; // Pixel format.
      else if (type === 2) {
        if (b.length < 4) return;
        const n = b.readUInt16BE(2);
        if (n > 256) throw Error('Too many RFB encodings');
        length = 4 + 4 * n;
      } else if (type === 3)
        length = 10; // Framebuffer request.
      else if (type === 4) {
        length = 8;
        write = true;
      } else if (type === 5) {
        if (b.length < 2) return;
        length = b[1] & 128 ? 7 : 6;
        write = true;
      } else if (type === 6) {
        if (b.length < 8) return;
        const n = Math.abs(b.readInt32BE(4));
        if (n > 65536) throw Error('Clipboard exceeds limit');
        length = 8 + n;
      } else if (type === 150)
        length = 10; // Continuous framebuffer updates.
      else if (type === 248) {
        if (b.length < 9) return;
        if (b[8] > 64) throw Error('RFB fence exceeds limit');
        length = 9 + b[8];
      } else if (type === 251) {
        if (b.length < 8) return;
        if (b[6] > 16) throw Error('Too many virtual screens');
        length = 8 + b[6] * 16;
        write = true;
      } else if (type === 255) {
        if (b.length < 2) return;
        if (b[1] !== 0) throw Error('Unknown QEMU input extension');
        length = 12;
        write = true;
      } else throw Error('Unsupported RFB client message');
      if (b.length < length) return;
      let message = this.take(length);
      if (type === 6) {
        this.onRejected('clipboard');
        continue;
      } // Explicit transfer API only.
      if (type === 2) {
        const enc = [];
        for (let i = 4; i < message.length; i += 4) {
          const v = message.readUInt32BE(i);
          if (![-316 >>> 0, -309 >>> 0, 0xc0a1e5ce].includes(v)) enc.push(v);
        }
        message = Buffer.alloc(4 + enc.length * 4);
        message[0] = 2;
        message.writeUInt16BE(enc.length, 2);
        enc.forEach((v, i) => message.writeUInt32BE(v, 4 + i * 4));
      }
      if (write && !this.canWrite()) {
        this.onRejected('ownership');
        continue;
      }
      this.forward(message);
      if (write) this.onForwarded(message);
    }
  }
  take(length) {
    const part = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return part;
  }
}
