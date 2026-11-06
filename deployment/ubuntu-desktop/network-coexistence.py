#!/usr/bin/python3
"""Lets the VM bridge through the host firewall, after the owner said yes. It finds the firewall itself.
A packet must pass every base chain on a hook, so an accept in our own table is not enough.
Every rule names the bridge, and nothing here flushes, reorders or changes a policy or a host rule.
The forward rules name no uplink: the guard table runs first and drops every private address,
so only public destinations remain, whichever interface the host uses today.

--check says what is there. Exit 0: nothing blocks the bridge. 10: rules are needed. 1: could not tell.
--watch stays running and puts back what a firewall reload cleared. Not every firewall reloads
through a unit that systemd can tie this to, and one that loads later than this needs its rules too.
"""

import json, pathlib, re, shutil, subprocess, sys, time

BRIDGE = 'virbr-scx'
NETWORK = '192.168.153.0/24'
HOST = '192.168.153.1'
# firewalld refuses zone names over 17 characters.
ZONE = 'scx-desktops'
UNIT = 'stellarcortex-desktop-network-coexistence.service'
GUARD = 'stellarcortex-desktop-network-guard.service'
WATCH_SECONDS = 30
# Other tools own these tables: the guard is ours, firewalld and libvirt rebuild theirs.
LEFT_ALONE = {'scx_desktops', 'firewalld', 'libvirt_network'}
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}')
# Hook, nft rule, the same rule for iptables, and the comment that marks it as ours.
RULES = [
    (
        'input',
        f'iifname "{BRIDGE}" udp sport 68 udp dport 67 accept',
        ['-i', BRIDGE, '-p', 'udp', '--sport', '68', '--dport', '67'],
        'scx-desktop-dhcp',
    ),
    (
        'input',
        f'iifname "{BRIDGE}" ip daddr {HOST} udp dport 53 accept',
        ['-i', BRIDGE, '-d', HOST, '-p', 'udp', '--dport', '53'],
        'scx-desktop-dns-udp',
    ),
    (
        'input',
        f'iifname "{BRIDGE}" ip daddr {HOST} tcp dport 53 accept',
        ['-i', BRIDGE, '-d', HOST, '-p', 'tcp', '--dport', '53'],
        'scx-desktop-dns-tcp',
    ),
    (
        'forward',
        f'iifname "{BRIDGE}" ip saddr {NETWORK} accept',
        ['-i', BRIDGE, '-s', NETWORK],
        'scx-desktop-public-out',
    ),
    (
        'forward',
        f'oifname "{BRIDGE}" ip daddr {NETWORK} ct state established,related accept',
        ['-o', BRIDGE, '-d', NETWORK, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED'],
        'scx-desktop-public-reply',
    ),
]
COMMENTS = {rule[3] for rule in RULES}
UFW = [
    ['allow', 'in', 'on', BRIDGE, 'to', 'any', 'port', '67', 'proto', 'udp'],
    ['allow', 'in', 'on', BRIDGE, 'to', HOST, 'port', '53', 'proto', 'udp'],
    ['allow', 'in', 'on', BRIDGE, 'to', HOST, 'port', '53', 'proto', 'tcp'],
    ['route', 'allow', 'in', 'on', BRIDGE, 'from', NETWORK],
]


def output(*args):
    '''What a tool printed, or None when it is not installed or failed.'''
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    return result.stdout if result.returncode == 0 else None


def ruleset():
    text = output('nft', '-j', 'list', 'ruleset')
    if text is None:
        raise SystemExit('Could not read the nftables ruleset. No rules were changed.')
    try:
        return json.loads(text)['nftables']
    except (ValueError, KeyError):
        raise SystemExit('Could not understand the nftables ruleset. No rules were changed.')


def blocking_chains(items):
    '''The base chains that could drop bridge traffic, as (family, table, chain, hook).'''
    rules = [item['rule'] for item in items if 'rule' in item]
    found = []
    for chain in (item['chain'] for item in items if 'chain' in item):
        family, table, name = chain['family'], chain['table'], chain['name']
        # iptables-nft keeps its chains here, in upper case, and an nft rule can break iptables.
        managed = table in LEFT_ALONE or (family, table, name.isupper()) == ('ip', 'filter', True)
        if (
            managed
            or family not in ['ip', 'inet']
            or chain.get('type') != 'filter'
            or chain.get('hook') not in ['input', 'forward']
        ):
            continue
        stops = any(
            re.search(r'"(drop|reject|jump|goto)"', json.dumps(rule['expr']))
            for rule in rules
            if (rule['family'], rule['table'], rule['chain']) == (family, table, name)
        )
        if chain.get('policy') == 'drop' or stops:
            found.append((family, table, name, chain['hook']))
    return found


def ufw_active():
    return 'Status: active' in (output('ufw', 'status') or '')


def firewalld_active():
    return (output('firewall-cmd', '--state') or '').strip() == 'running'


def iptables_blocks():
    '''Legacy iptables rules do not show in nft, and Docker sets FORWARD to drop.'''
    text = (output('iptables', '-w', '-S', 'INPUT') or '') + (
        output('iptables', '-w', '-S', 'FORWARD') or ''
    )
    return bool(re.search(r'^-P \w+ DROP|^-A \w+ .*-j (DROP|REJECT)\b', text, re.M))


def tools():
    '''ufw and firewalld own the iptables rules on a host that runs them.'''
    if ufw_active():
        return ['ufw']
    if firewalld_active():
        return ['firewalld']
    return ['iptables'] if iptables_blocks() else []


def check():
    names = tools() + sorted({f'nftables table {c[1]}' for c in blocking_chains(ruleset())})
    print(', '.join(names))
    return 10 if names else 0


def nft_apply(items):
    existing = {
        (r['family'], r['table'], r['chain'], r.get('comment'))
        for r in (item['rule'] for item in items if 'rule' in item)
    }
    changes = []
    for family, table, chain, hook in blocking_chains(items):
        if not NAME.fullmatch(table) or not NAME.fullmatch(chain):
            raise SystemExit(f'Unexpected chain name {table} {chain}. No rules were changed.')
        for rule_hook, expression, _, comment in RULES:
            if rule_hook == hook and (family, table, chain, comment) not in existing:
                changes.append(
                    f'insert rule {family} {table} {chain} {expression} comment "{comment}"'
                )
    return changes


def nft_remove(items):
    return [
        f'delete rule {r["family"]} {r["table"]} {r["chain"]} handle {r["handle"]}'
        for r in (item['rule'] for item in items if 'rule' in item)
        if r.get('comment') in COMMENTS
    ]


def nft_run(changes):
    if changes:
        script = '\n'.join(changes) + '\n'
        subprocess.run(['nft', '--check', '-f', '-'], input=script, text=True, check=True)
        subprocess.run(['nft', '-f', '-'], input=script, text=True, check=True)


def iptables_rule(chain, args, comment):
    return [chain, *args, '-m', 'comment', '--comment', comment, '-j', 'ACCEPT']


def iptables_apply():
    for hook, _, args, comment in RULES:
        chain, rule = hook.upper(), iptables_rule(hook.upper(), args, comment)
        if subprocess.run(['iptables', '-w', '-C', *rule], capture_output=True).returncode:
            subprocess.run(['iptables', '-w', '-I', chain, '1', *rule[1:]], check=True)


def iptables_remove():
    for hook, _, args, comment in RULES:
        rule = iptables_rule(hook.upper(), args, comment)
        try:
            while not subprocess.run(
                ['iptables', '-w', '-D', *rule], capture_output=True
            ).returncode:
                pass
        except FileNotFoundError:
            return


def firewalld_apply():
    # libvirt ships this zone and puts its bridges in it. The guard narrows it to DHCP and DNS.
    zones = (output('firewall-cmd', '--permanent', '--get-zones') or '').split()
    if 'libvirt' in zones or ZONE in zones:
        return
    for args in [
        ['--new-zone=' + ZONE],
        ['--zone=' + ZONE, '--set-target=ACCEPT'],
        ['--zone=' + ZONE, '--add-interface=' + BRIDGE],
    ]:
        subprocess.run(['firewall-cmd', '--permanent', *args], check=True)
    subprocess.run(['firewall-cmd', '--reload'], check=True)


def firewalld_remove():
    if ZONE in (output('firewall-cmd', '--permanent', '--get-zones') or '').split():
        subprocess.run(['firewall-cmd', '--permanent', '--delete-zone=' + ZONE], check=False)
        subprocess.run(['firewall-cmd', '--reload'], check=False)


def guarded():
    '''The ruleset with the guard in it. A flush takes the guard too, and the forward rules lean on it.'''
    loaded = lambda items: any(i.get('table', {}).get('name') == 'scx_desktops' for i in items)
    items = ruleset()
    if not loaded(items):
        subprocess.run(['systemctl', 'reload', GUARD], capture_output=True)
        items = ruleset()
    if not loaded(items):
        raise SystemExit('The network guard is not loaded, so no rules were added.')
    return items


def apply(again=False):
    '''ufw and firewalld keep their own rules through a reload, so a later pass leaves them be.'''
    items = guarded()
    active = tools()
    if 'ufw' in active and not again:
        for rule in UFW:
            subprocess.run(['ufw', *rule, 'comment', 'stellarcortex-desktop'], check=True)
    if 'firewalld' in active and not again:
        firewalld_apply()
    if 'iptables' in active:
        iptables_apply()
    nft_run(nft_apply(items))


def watch():
    reported = None
    while True:
        time.sleep(WATCH_SECONDS)
        try:
            apply(again=True)
            problem = None
        # Nothing may end this: the rules go with it, and only a reboot brings them back.
        except (Exception, SystemExit) as error:
            problem = f'The rules for {BRIDGE} could not be put back: {error}'
        if problem and problem != reported:
            print(problem, flush=True)
        reported = problem


def remove():
    if output('ufw', 'version') is not None:
        for rule in UFW:
            command = ['route', 'delete', *rule[1:]] if rule[0] == 'route' else ['delete', *rule]
            subprocess.run(['ufw', *command], capture_output=True)
    if firewalld_active():
        firewalld_remove()
    else:
        output('firewall-offline-cmd', '--delete-zone=' + ZONE)
    iptables_remove()
    nft_run(nft_remove(ruleset()))
    print('Firewall rules for', BRIDGE, 'are removed')


def install():
    '''For a firewall that came after the install. A later boot applies the rules again.'''
    here = pathlib.Path(__file__).resolve().parent
    shutil.copy(
        here / 'network-coexistence.py', '/etc/stellarcortex/desktop-network-coexistence.py'
    )
    shutil.copy(here / 'network-coexistence.service', '/etc/systemd/system/' + UNIT)
    for args in [['daemon-reload'], ['enable', UNIT], ['restart', UNIT]]:
        subprocess.run(['systemctl', *args], check=True)


def main():
    action = {
        (): apply,
        ('--check',): check,
        ('--remove',): remove,
        ('--watch',): watch,
        ('--install',): install,
    }.get(tuple(sys.argv[1:]))
    if action is None:
        raise SystemExit('Usage: network-coexistence.py [--check | --remove | --watch | --install]')
    try:
        sys.exit(action() or 0)
    except subprocess.CalledProcessError as error:
        raise SystemExit(
            f'A firewall command failed: {error.cmd[0]}. Some rules may not be in place.'
        )


if __name__ == '__main__':
    main()
