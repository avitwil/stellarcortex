#!/usr/bin/python3
import subprocess, time

for _ in range(100):
    if (
        subprocess.run(
            ['/usr/bin/xdotool', 'getdisplaygeometry'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    ):
        break
    time.sleep(0.1)
else:
    raise SystemExit('Session display did not become available')
