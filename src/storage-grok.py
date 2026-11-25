"""Share identical Grok binary extents on Linux Btrfs. Keep every directory entry."""
import collections
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import tempfile

NAME = re.compile(r"sub_[0-9a-f]+/grok-[0-9a-f]+/bin/grok-\d+\.\d+\.\d+")
CHUNK = 16 * 1024 * 1024


def metadata(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns)


def verified_open(path, expected):
    stream = os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb")
    if metadata(os.fstat(stream.fileno())) != expected or path.resolve() != path:
        stream.close()
        raise ValueError("Grok binary changed during scan")
    return stream


def checksum(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.digest()


def share(source, target, size):
    for offset in range(0, size, CHUNK):
        length = min(CHUNK, size - offset)
        data = bytearray(struct.pack("=QQHHIqQQiI", offset, length, 1, 0, 0,
                                     target.fileno(), offset, 0, 0, 0))
        # Linux FIDEDUPERANGE compares the bytes in-kernel before sharing each extent.
        fcntl.ioctl(source.fileno(), 0xc0189436, data, True)
        count, status = struct.unpack_from("=Qi", data, 40)
        if status or count != length:
            raise OSError("Filesystem refused to share identical extents")


def run(root, preview, ledger=None):
    result = {"copies": 0, "preview": preview}
    if sys.platform != "linux" or not root.exists():
        return {**result, "supported": False}
    if root.is_symlink() or root.resolve() != root:
        raise ValueError("Unexpected CLI work directory")
    groups = collections.defaultdict(list)
    for path in sorted(root.glob("sub_*/grok-*/bin/grok-*")):
        if not NAME.fullmatch(path.relative_to(root).as_posix()) or path.resolve() != path:
            continue
        info = path.lstat()
        if (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and info.st_size and info.st_mode & 0o111 and not info.st_mode & 0o022):
            groups[(info.st_dev, path.name, info.st_size)].append((path, metadata(info)))
    if subprocess.check_output(["stat", "-f", "-c", "%T", root], text=True).strip() != "btrfs":
        return {**result, "supported": False}
    def signature():
        return [[str(path.relative_to(root)), *metadata(path.lstat()), path.lstat().st_ctime_ns]
                for group in groups.values() if len(group) > 1 for path, _ in group]

    before = signature()
    if ledger and ledger.is_file() and not ledger.is_symlink():
        try:
            cached = json.loads(ledger.read_text())
            if cached["signature"] == before:
                return {**result, "copies": cached["copies"], "supported": True, "alreadyVerified": True}
        except (ValueError, KeyError, TypeError):
            pass
    for candidates in groups.values():
        if len(candidates) < 2:
            continue
        sources = {}
        for path, info in candidates:
            with verified_open(path, info) as target:
                digest = checksum(target)
                if digest not in sources:
                    sources[digest] = (path, info)
                    continue
                if not preview:
                    with verified_open(*sources[digest]) as source:
                        share(source, target, info[6])
                    if metadata(path.lstat()) != info:
                        raise ValueError("Grok metadata changed")
                result["copies"] += 1
    if ledger and not preview:
        after = signature()
        if [row[:-1] for row in after] != [row[:-1] for row in before]:
            raise ValueError("Grok files changed during deduplication")
        with tempfile.NamedTemporaryFile(mode="w", dir=ledger.parent, delete=False) as stream:
            json.dump({"signature": after, "copies": result["copies"]}, stream)
        os.replace(stream.name, ledger)
    return {**result, "supported": True}


if __name__ == "__main__":
    print(json.dumps(run(Path(sys.argv[1]).absolute(), sys.argv[2] == "preview", Path(sys.argv[3]))))
