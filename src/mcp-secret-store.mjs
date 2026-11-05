import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

// Separate from exported application state and bot workspaces. The encryption
// key is protected by the host OS account, not by the application export format.
export class McpSecretStore {
  constructor(dataDir, name = 'mcp-connections') {
    if (!/^[a-z][a-z0-9-]{0,60}$/.test(name)) throw new Error('Invalid secret store name');
    this.dir = path.join(path.resolve(dataDir), 'private');
    this.file = path.join(this.dir, `${name}.enc`);
    this.keyFile = path.join(this.dir, `${name}.key`);
    this.data = {};
    if (fs.existsSync(this.file)) {
      try {
        this.key = fs.readFileSync(this.keyFile);
        const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (this.key.length !== 32 || envelope.version !== 1) throw new Error();
        const cipher = createDecipheriv(
          'aes-256-gcm',
          this.key,
          Buffer.from(envelope.iv, 'base64'),
        );
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        this.data = JSON.parse(
          Buffer.concat([
            cipher.update(Buffer.from(envelope.data, 'base64')),
            cipher.final(),
          ]).toString('utf8'),
        );
      } catch {
        throw new Error(
          'Saved MCP credentials could not be decrypted. Restore the matching private connection files and key.',
        );
      }
    }
  }
  save(data = this.data) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.keyFile))
      fs.writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    this.key = fs.readFileSync(this.keyFile);
    if (this.key.length !== 32) throw new Error('Invalid MCP encryption key');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv),
      encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const temp = path.join(this.dir, `mcp-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(
        temp,
        JSON.stringify({
          version: 1,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      fs.renameSync(temp, this.file);
      this.data = data;
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
}
