#!/usr/bin/python3
"""Root-owned session router. Not installed or started by importing this file.
Only the host vsock CID may select a registered bot session. Local Unix peer
credentials must match the registration before any request or display is sent.
"""

import json, os, pathlib, re, select, socket, stat, struct, threading

IDENTITY = ('accountId', 'environmentId', 'computerId', 'botId', 'vmId', 'generation', 'sessionId')


def identity(value):
    if not isinstance(value, dict) or any(
        not isinstance(value.get(k), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value[k])
        for k in IDENTITY
    ):
        raise ValueError('Complete trusted session identity required')
    return {k: value[k] for k in IDENTITY}


def records_from(value):
    records = {}
    uids = set()
    bots = set()
    computer = None
    for row in value['sessions']:
        scope = identity(row)
        uid = row.get('uid')
        current = tuple(
            scope[k] for k in ['accountId', 'environmentId', 'computerId', 'vmId', 'generation']
        )
        if computer is not None and current != computer:
            raise ValueError(
                'The guest session registry mixes owners or computers. Re-key or remove the old sessions in /etc/stellarcortex/session-registry.json'
            )
        computer = current
        if scope['botId'] in bots:
            raise ValueError('One desktop per bot required')
        bots.add(scope['botId'])
        if (
            type(uid) != int
            or not 1000 <= uid <= 60000
            or uid in uids
            or scope['sessionId'] in records
        ):
            raise ValueError('Distinct unprivileged session users required')
        if type(row.get('enabled')) != bool:
            raise ValueError('Explicit session access required')
        records[scope['sessionId']] = {**scope, 'uid': uid, 'enabled': row['enabled']}
        uids.add(uid)
    return records


def select_session(request, records):
    display = request.get('protocol') == 'scx-session-v1' and request.get('channel') == 'display'
    if not display and request.get('protocol') != 'scx-guest-v1':
        raise ValueError('Unsupported private session protocol')
    scope = identity(request.get('scope') if display else request)
    record = records.get(scope['sessionId'])
    if not record or not record['enabled'] or identity(record) != scope:
        raise ValueError('Session not authorized')
    return record, 'vnc.sock' if display else 'worker.sock', display


def connect_peer(record, name, root='/run/user'):
    target = pathlib.Path(root) / str(record['uid']) / 'stellarcortex' / name
    meta = target.lstat()
    if not stat.S_ISSOCK(meta.st_mode) or meta.st_uid != record['uid'] or meta.st_mode & 0o077:
        raise ValueError('Private session socket required')
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        peer.settimeout(10)
        peer.connect(str(target))
        _pid, uid, _gid = struct.unpack(
            '3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        )
        if uid != record['uid']:
            raise ValueError('Session peer identity mismatch')
        peer.settimeout(None)
        return peer
    except Exception:
        peer.close()
        raise


def read_header(channel):
    data = bytearray()
    while not data.endswith(b'\n'):
        part = channel.recv(1)
        if not part:
            raise ValueError('Missing session request')
        data.extend(part)
        if len(data) > 1048576:
            raise ValueError('Session request too large')
    return json.loads(data), bytes(data)


def load_registry():
    file = pathlib.Path('/etc/stellarcortex/session-registry.json')
    meta = file.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
        raise ValueError('Root-owned session registry required')
    return records_from(json.loads(file.read_text()))


def relay(incoming, address):
    with incoming:
        if address[0] != socket.VMADDR_CID_HOST:
            return
        try:
            incoming.settimeout(10)
            request, raw = read_header(incoming)
            try:
                registry = load_registry()
            except ValueError as error:
                # The host cannot read this guest's logs, so the reason goes back with the refusal.
                incoming.sendall(json.dumps({'relayError': str(error)}).encode() + b'\n')
                return
            record, name, display = select_session(request, registry)
            with connect_peer(record, name) as peer:
                if display:
                    incoming.sendall(
                        json.dumps({'ready': True, 'scope': identity(record)}).encode() + b'\n'
                    )
                else:
                    peer.sendall(raw)
                incoming.settimeout(None)
                while True:
                    # Revocation closes existing displays as well as rejecting new requests.
                    current = load_registry().get(record['sessionId'])
                    if current != record:
                        return
                    readable, _, _ = select.select([incoming, peer], [], [], 1)
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (peer if source is incoming else incoming).sendall(data)
        except (ValueError, OSError, KeyError, TypeError):
            return


def main():
    if os.getuid() != 0 or os.environ.get('STELLARCORTEX_INSIDE_GUEST') != '1':
        raise SystemExit('Dedicated guest root service required')
    load_registry()
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as listener:
        listener.bind((socket.VMADDR_CID_ANY, 701))
        listener.listen(32)
        while True:
            connection, address = listener.accept()
            threading.Thread(target=relay, args=(connection, address), daemon=True).start()


if __name__ == '__main__':
    main()
