#!/usr/bin/python3
"""Only bridge-scoped coexistence rules; never flush or change chain policy.
Host firewall names come from the environment (see README.md, "Firewall coexistence").
The forward table is optional: if it does not exist, forward rules are skipped."""

import json, os, re, subprocess, sys

NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,63}')
IFACE = re.compile(r'[A-Za-z0-9_.-]{1,15}')
GUIDE = 'Set it in /etc/stellarcortex/desktop-network-coexistence.env (see deployment/ubuntu-desktop/README.md). No rules were changed.'


def setting(name, default, pattern):
    value = os.environ.get(name) or default
    if value is None:
        return None
    if not pattern.fullmatch(value):
        raise SystemExit(f'{name}={value!r} is not a valid nftables/interface name. {GUIDE}')
    return value


def rules(input_table, input_chain, forward_table, forward_chain, uplink):
    out = lambda e: None if uplink is None else e.replace('UPLINK', uplink)
    return [
        (
            input_table,
            input_chain,
            False,
            'iifname "virbr-scx" udp sport 68 udp dport 67 accept',
            'scx-desktop-dhcp',
        ),
        (
            input_table,
            input_chain,
            False,
            'iifname "virbr-scx" ip daddr 192.168.153.1 udp dport 53 accept',
            'scx-desktop-dns-udp',
        ),
        (
            input_table,
            input_chain,
            False,
            'iifname "virbr-scx" ip daddr 192.168.153.1 tcp dport 53 accept',
            'scx-desktop-dns-tcp',
        ),
        (
            forward_table,
            forward_chain,
            True,
            out('iifname "virbr-scx" oifname "UPLINK" ip saddr 192.168.153.0/24 accept'),
            'scx-desktop-public-out',
        ),
        (
            forward_table,
            forward_chain,
            True,
            out(
                'iifname "UPLINK" oifname "virbr-scx" ip daddr 192.168.153.0/24 ct state established,related accept'
            ),
            'scx-desktop-public-reply',
        ),
    ]


def main():
    remove = sys.argv[1:] == ['--remove']
    assert sys.argv[1:] in ([], ['--remove'])
    config = dict(
        input_table=setting('STELLARCORTEX_DESKTOP_FW_INPUT_TABLE', 'filter', NAME),
        input_chain=setting('STELLARCORTEX_DESKTOP_FW_INPUT_CHAIN', 'input', NAME),
        forward_table=setting('STELLARCORTEX_DESKTOP_FW_FORWARD_TABLE', 'filter', NAME),
        forward_chain=setting('STELLARCORTEX_DESKTOP_FW_FORWARD_CHAIN', 'forward', NAME),
        uplink=setting('STELLARCORTEX_DESKTOP_UPLINK', None, IFACE),
    )
    try:
        tables = json.loads(subprocess.check_output(['nft', '-j', 'list', 'tables'], text=True))
    except FileNotFoundError:
        raise SystemExit('nft not found: install nftables first. No rules were changed.')
    existing = {
        (x['table']['family'], x['table']['name']) for x in tables['nftables'] if 'table' in x
    }
    changes = []
    for table, chain, forward, expression, comment in rules(**config):
        result = subprocess.run(
            ['nft', '-j', 'list', 'chain', 'inet', table, chain], capture_output=True, text=True
        )
        if result.returncode:
            if remove:
                continue
            if forward and ('inet', table) not in existing:
                print(f'Forward table inet {table} not found; skipping {comment}', file=sys.stderr)
                continue
            kind = 'FORWARD' if forward else 'INPUT'
            raise SystemExit(
                f'Expected existing firewall chain "inet {table} {chain}" missing; review required. Set STELLARCORTEX_DESKTOP_FW_{kind}_TABLE and STELLARCORTEX_DESKTOP_FW_{kind}_CHAIN to an existing inet table/chain on this host. {GUIDE}'
            )
        if expression is None and not remove:
            raise SystemExit(
                f'STELLARCORTEX_DESKTOP_UPLINK is not set: name the host uplink interface (for example eth0) used for guest outbound traffic. {GUIDE}'
            )
        matches = [
            x['rule']['handle']
            for x in json.loads(result.stdout)['nftables']
            if 'rule' in x and x['rule'].get('comment') == comment
        ]
        if remove:
            changes.extend(f'delete rule inet {table} {chain} handle {h}' for h in matches)
        elif not matches:
            changes.append(f'insert rule inet {table} {chain} {expression} comment "{comment}"')
    if changes:
        script = '\n'.join(changes) + '\n'
        subprocess.run(['nft', '--check', '-f', '-'], input=script, text=True, check=True)
        subprocess.run(['nft', '-f', '-'], input=script, text=True, check=True)
    print('Removed' if remove else 'Applied', len(changes), 'owned bridge-only coexistence rules')


if __name__ == '__main__':
    main()
