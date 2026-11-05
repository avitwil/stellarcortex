#!/usr/bin/python3
"""What the host reads to learn how first boot went. A killed unit cannot leave a mark of its own, so systemd's answer counts too."""

import json, pathlib, subprocess

DONE = pathlib.Path('/var/lib/stellarcortex-installed.json')
FAILED = pathlib.Path('/var/lib/stellarcortex-firstboot-failed')
CURRENT = pathlib.Path('/var/lib/stellarcortex-firstboot/current')


def unit():
    shown = subprocess.run(
        [
            '/usr/bin/systemctl',
            'show',
            'stellarcortex-firstboot.service',
            '--property=ActiveState,Result',
        ],
        capture_output=True,
        text=True,
    ).stdout
    return dict(line.split('=', 1) for line in shown.splitlines() if '=' in line)


def report(done=DONE, failed=FAILED, current=CURRENT, unit=unit):
    if done.exists():
        return json.loads(done.read_text())
    if failed.exists():
        return {'firstbootFailed': failed.read_text()[-300:]}
    state = unit()
    if state.get('ActiveState') != 'failed':
        return {}
    step = current.read_text().strip() if current.exists() else 'start'
    return {
        'firstbootFailed': step + ': the service stopped (' + state.get('Result', 'unknown') + ')'
    }


if __name__ == '__main__':
    print(json.dumps(report()))
