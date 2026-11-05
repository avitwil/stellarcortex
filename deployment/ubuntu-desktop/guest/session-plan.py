#!/usr/bin/python3
"""Pure session installation plan generator. It never installs or changes users."""

import hashlib, json, re

KEYS = ('accountId', 'environmentId', 'computerId', 'vmId', 'generation', 'botId')


def plan_session(scope, uid, display_number):
    if any(
        not isinstance(scope.get(k), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', scope[k])
        for k in KEYS
    ):
        raise ValueError('Trusted computer and bot identities required')
    if (
        type(uid) != int
        or not 1000 <= uid <= 60000
        or type(display_number) != int
        or not 1 <= display_number <= 4095
    ):
        raise ValueError('Allocated UID and display required')
    digest = hashlib.sha256(
        json.dumps({k: scope[k] for k in KEYS}, sort_keys=True).encode()
    ).hexdigest()[:20]
    username = 'scxb_' + digest
    session = 'desktop-' + digest
    home = '/home/' + username
    runtime = '/run/user/' + str(uid)
    record = {
        **{k: scope[k] for k in KEYS},
        'sessionId': session,
        'uid': uid,
        'displayNumber': display_number,
        'enabled': True,
    }
    return {
        'record': record,
        'user': {
            'name': username,
            'uid': uid,
            'home': home,
            'mode': '0700',
            'password': 'locked',
            'sudo': False,
            'supplementaryGroups': [],
        },
        'session': {
            'display': ':' + str(display_number),
            'runtime': runtime,
            'dbus': 'private dbus-run-session',
            'xauthority': home + '/.Xauthority',
            'vncSocket': runtime + '/stellarcortex/vnc.sock',
            'workerSocket': runtime + '/stellarcortex/worker.sock',
            'socketMode': '0600',
            'tcpListeners': False,
            'hostOnlyVsockPort': 701,
        },
        'preserveExistingHomes': True,
        'copyCredentials': False,
        'provisionNewVM': False,
    }
