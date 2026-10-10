"""POSIX test harness: pass argv directly to a real PTY, without a shell."""
import errno
import os
import pty
import select
import signal
import subprocess
import sys

master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)


def forward_signal(number, _frame):
    try:
        os.killpg(child.pid, number)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGINT, forward_signal)
inputs = [master, sys.stdin.fileno()]
try:
    while inputs and child.poll() is None:
        ready, _, _ = select.select(inputs, [], [], 0.2)
        for descriptor in ready:
            try:
                data = os.read(descriptor, 65536)
            except OSError as error:
                if descriptor != master or error.errno != errno.EIO:
                    raise
                data = b''
            if not data:
                inputs.remove(descriptor)
            else:
                os.write(sys.stdout.fileno() if descriptor == master else master, data)
finally:
    os.close(master)
    if child.poll() is None:
        forward_signal(signal.SIGTERM, None)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            forward_signal(signal.SIGKILL, None)
    sys.exit(child.wait())
