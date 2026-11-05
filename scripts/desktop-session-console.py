#!/usr/bin/python3
"""Host broker's bounded private vsock display connector; no TCP listener."""

import json, select, socket, sys


def main():
    cid = int(sys.argv[1])
    if not 3 <= cid <= 0xFFFFFFFE:
        raise ValueError('Registered guest CID required')
    header = sys.stdin.buffer.readline(4097)
    if len(header) > 4096 or not header.endswith(b'\n'):
        raise ValueError('Bounded display identity required')
    request = json.loads(header)
    if request.get('protocol') != 'scx-session-v1' or request.get('channel') != 'display':
        raise ValueError('Display request required')
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as channel:
        channel.settimeout(10)
        channel.connect((cid, 701))
        channel.sendall(header)
        reply = bytearray()
        while not reply.endswith(b'\n'):
            part = channel.recv(1)
            if not part or len(reply) > 4096:
                raise ValueError('No confirmed session display')
            reply.extend(part)
        acknowledged = json.loads(reply)
        if acknowledged.get('ready') is not True or acknowledged.get('scope') != request.get(
            'scope'
        ):
            raise ValueError('Display identity mismatch')
        sys.stdout.buffer.write(reply)
        sys.stdout.buffer.flush()
        channel.settimeout(None)
        while True:
            ready, _, _ = select.select([channel, sys.stdin.buffer], [], [])
            for stream in ready:
                data = channel.recv(65536) if stream is channel else sys.stdin.buffer.read1(65536)
                if not data:
                    return
                if stream is channel:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    channel.sendall(data)


if __name__ == '__main__':
    main()
