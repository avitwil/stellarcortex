#!/usr/bin/python3
"""Checks that a bot session has a working screen. Pure logic, so install-sessions.py stays the only actor."""

import time

SCREEN = {
    '/usr/bin/Xtigervnc': 'tigervnc-standalone-server',
    '/usr/bin/startxfce4': 'xfce4',
    '/usr/bin/xauth': 'xauth',
    '/usr/bin/dbus-launch': 'dbus-x11',
    '/usr/bin/xdotool': 'xdotool',
    '/usr/bin/import': 'imagemagick',
    '/usr/bin/xdg-open': 'xdg-utils',
    '/usr/bin/xset': 'x11-xserver-utils',
    '/usr/bin/xfce4-terminal': 'xfce4-terminal',
}
# Ubuntu Server has none of these either. The fonts include Hebrew. The product uses no audio.
SUPPORT = [
    'dbus-user-session',
    'at-spi2-core',
    'x11-utils',
    'x11-xkb-utils',
    'xfonts-base',
    'fontconfig',
    'adwaita-icon-theme',
    'fonts-culmus',
    'fonts-dejavu-core',
    'fonts-liberation',
    'fonts-noto-color-emoji',
]
# What fetches Chromium and what it links to, from Playwright's list for this release. They come with the installation, in its one apt pass.
BROWSER = [
    'curl',
    'unzip',
    'libasound2t64',
    'libatk-bridge2.0-0t64',
    'libatk1.0-0t64',
    'libatspi2.0-0t64',
    'libcairo2',
    'libcups2t64',
    'libdbus-1-3',
    'libdrm2',
    'libgbm1',
    'libglib2.0-0t64',
    'libnspr4',
    'libnss3',
    'libpango-1.0-0',
    'libx11-6',
    'libxcb1',
    'libxcomposite1',
    'libxdamage1',
    'libxext6',
    'libxfixes3',
    'libxkbcommon0',
    'libxrandr2',
]
PACKAGES = [*SCREEN.values(), *SUPPORT, *BROWSER]


def ensure_screen_software(exists, install):
    # A computer installed earlier may not have these packages.
    missing = [package for file, package in SCREEN.items() if not exists(file)]
    if missing:
        install(missing + SUPPORT)
    absent = [file for file in SCREEN if not exists(file)]
    if absent:
        raise SystemExit('Screen software missing: ' + ', '.join(absent))


def wait_for_screen(ready, attempts=60, pause=1, sleep=time.sleep):
    # Three good checks in a row, because a failing unit restarts and looks active for a moment.
    good = 0
    for _ in range(attempts):
        good = good + 1 if ready() else 0
        if good == 3:
            return
        sleep(pause)
    raise SystemExit('Bot screen did not start; the session was not registered')


if __name__ == '__main__':
    print(' '.join(PACKAGES))
