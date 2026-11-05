#!/usr/bin/python3
"""One bounded request to a registered guest CID; parent broker owns selection."""

import sys, socket, json

cid = int(sys.argv[1])
timeout = int(sys.argv[2])
assert 3 <= cid <= 0xFFFFFFFE and 1 <= timeout <= 3605
port = int(sys.argv[3]) if len(sys.argv) > 3 else 7000
if port not in (7000, 701):
    raise SystemExit('Unsupported private guest channel')
payload = sys.stdin.buffer.read(1048577)
if len(payload) > 1048576 or b'\n' in payload:
    raise SystemExit('Bounded single request required')
with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as channel:
    channel.settimeout(timeout)
    channel.connect((cid, port))
    channel.sendall(payload + b'\n')
    data = bytearray()
    while b'\n' not in data:
        part = channel.recv(65536)
        if not part:
            raise SystemExit('Guest disconnected before reply')
        data.extend(part)
        if len(data) > 16777216:
            raise SystemExit('Guest reply exceeds limit')
    reply = bytes(data).split(b'\n', 1)[0]
    json.loads(reply)
    sys.stdout.buffer.write(reply)
