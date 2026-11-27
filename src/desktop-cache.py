import contextlib
import errno
import socket
import sys
import tempfile
from pathlib import Path
import json
import os
import re
import stat
import time

MIN_AGE = 7 * 86400
DIR_FLAGS = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY

def busy_tools():
    names = set()
    for pid in os.listdir('/proc'):
        if pid.isdecimal():
            try:
                with open(f'/proc/{pid}/comm') as f:
                    names.add(f.read().strip().lower())
            except (PermissionError, FileNotFoundError, ProcessLookupError):
                pass
    return names

def clean(root, apply, processes):
    cutoff = time.time() - MIN_AGE
    result = {}
    with contextlib.ExitStack() as stack:
        def directory(parent, name):
            fd = os.open(name, DIR_FLAGS, dir_fd=parent)
            stack.callback(os.close, fd)
            return fd
        base = directory(None, root)
        device = os.fstat(base).st_dev
        def walk(fd, levels, stats):
            if os.fstat(fd).st_dev != device:
                return
            for name in os.listdir(fd):
                if not levels[0].fullmatch(name):
                    continue
                try:
                    if len(levels) > 1:
                        child = os.open(name, DIR_FLAGS, dir_fd=fd)
                        try:
                            walk(child, levels[1:], stats)
                        finally:
                            os.close(child)
                        continue
                    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_dev != device or max(st.st_atime, st.st_mtime) >= cutoff:
                        continue
                    if apply:
                        os.unlink(name, dir_fd=fd)
                    stats['files'] += 1
                    stats['bytes'] += st.st_size
                    stats['allocated'] += st.st_blocks * 512
                except (FileNotFoundError, NotADirectoryError, PermissionError):
                    continue
        go = result['go'] = dict(files=0, bytes=0, allocated=0, busy=bool(processes & {'go', 'compile', 'link', 'gopls'}))
        if not go['busy']:
            try:
                go_cache = directory(directory(base, '.cache'), 'go-build')
                walk(go_cache, [re.compile('[0-9a-f]{2}'), re.compile('[0-9a-f]{64}-[ad]')], go)
            except (FileNotFoundError, NotADirectoryError):
                pass

        babel = result['babel'] = dict(files=0, bytes=0, allocated=0)
        work = Path(root) / 'work'
        if not work.is_symlink() and work.is_dir():
            excluded = {'.git', '.venv', '.cache', '.next', 'dist', 'build', 'vendor', 'node_modules'}
            for path, children, files, parent in os.fwalk(work, follow_symlinks=False):
                if os.fstat(parent).st_dev != device or len(Path(path).relative_to(work).parts) > 10:
                    children.clear()
                    continue
                has_modules = 'node_modules' in children
                children[:] = [child for child in children if child not in excluded and not child.startswith('.')]
                if not has_modules or 'package.json' not in files:
                    continue
                try:
                    with contextlib.ExitStack() as project:
                        fd = parent
                        for component in ('node_modules', '.cache', 'babel-loader'):
                            fd = os.open(component, DIR_FLAGS, dir_fd=fd)
                            project.callback(os.close, fd)
                        walk(fd, [re.compile(r'(?:[0-9a-f]{32}|[0-9a-f]{64})\.json(?:\.gz)?')], babel)
                except (FileNotFoundError, NotADirectoryError, PermissionError):
                    continue
    return result

INTERVAL = 86400
CONTROL = '\0cora-desktop-cache-v1'


def run_daily(home, listener, policy=None):
    state = home / '.local/state/cora'
    state.mkdir(parents=True, exist_ok=True)
    receipt = state / 'desktop-cache.json'
    while True:
        try:
            previous = json.loads(receipt.read_text())['completed']
            remaining = max(0, min(INTERVAL, previous + INTERVAL - time.time()))
        except (FileNotFoundError, ValueError, KeyError, TypeError):
            remaining = 0
        enabled = True
        if policy is not None:
            try:
                enabled = policy.read_text().strip() == 'on'
            except OSError:
                enabled = False
        timeout = remaining
        if policy is not None:
            timeout = min(remaining, 30) if enabled else 30
        listener.settimeout(max(0.05, timeout))
        try:
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(2)
                if conn.recv(8) == b'stop':
                    conn.sendall(b'ok')
                    return
        except socket.timeout:
            if remaining > 0 or not enabled:
                continue
            try:
                stats = clean(home, True, busy_tools())
            except OSError:
                time.sleep(60)
                continue
            with tempfile.NamedTemporaryFile(mode='w', dir=state, delete=False) as out:
                json.dump(dict(completed=int(time.time()), categories=stats), out)
            os.replace(out.name, receipt)


def configure(mode):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        if mode == 'off':
            try:
                channel.settimeout(30)
                channel.connect(CONTROL)
            except ConnectionRefusedError:
                return
            channel.sendall(b'stop')
            if channel.recv(2) != b'ok':
                raise RuntimeError('Desktop worker did not stop')
            return
        try:
            channel.bind(CONTROL)
        except OSError as error:
            if error.errno == errno.EADDRINUSE:
                return
            raise
        channel.listen(4)
        if mode == 'desktop':
            run_daily(Path.home(), channel, Path('/opt/cora/desktop-cache/policy'))
            return
        if os.fork():
            return
        os.setsid()
        with open(os.devnull, 'r+b', buffering=0) as sink:
            for fd in range(3):
                os.dup2(sink.fileno(), fd)
        run_daily(Path.home(), channel)


if __name__ == '__main__':
    if sys.argv[1:] not in (['on'], ['off'], ['desktop']):
        raise SystemExit(2)
    configure(sys.argv[1])
