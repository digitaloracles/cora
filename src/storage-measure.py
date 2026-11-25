"""Count allocated bytes using metadata only. Emits one small JSON object."""
import json
import os
import re
import stat
from pathlib import Path

CATEGORIES = ("logs", "backups", "cache", "work", "traces", "other")
LOG = re.compile(r"\.log(?:\.\d+)?(?:\.(?:gz|xz|zst))?$", re.I)


def measure(roots):
    counts = dict.fromkeys(CATEGORIES, 0)
    unreadable = 0
    seen = set()
    for root, group in roots:
        if not root.exists():
            continue
        device = root.stat().st_dev
        todo = [(root, group)]
        while todo:
            directory, parent = todo.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            info = entry.stat(follow_symlinks=False)
                        except FileNotFoundError:
                            continue
                        if info.st_dev != device:
                            continue
                        name = entry.name.lower()
                        kind = parent
                        if stat.S_ISDIR(info.st_mode):
                            if parent not in ("backups", "logs"):
                                if name in ("backups", "release-backups", "backup"):
                                    kind = "backups"
                                elif name in ("logs", "log"):
                                    kind = "logs"
                                elif name in (".cache", "cache", "_cacache", ".npm", ".gradle"):
                                    kind = "cache"
                                elif name in ("cli-work", "work") and parent == "other":
                                    kind = "work"
                                elif name in ("traces", "sessions") and parent != "cache":
                                    kind = "traces"
                            todo.append((entry.path, kind))
                        elif stat.S_ISREG(info.st_mode):
                            if info.st_nlink > 1:
                                key = (device, info.st_ino)
                                if key in seen:
                                    continue
                                seen.add(key)
                            if kind != "backups" and LOG.search(name):
                                kind = "logs"
                            counts[kind] += info.st_blocks * 512
            except FileNotFoundError:
                continue
            except PermissionError:
                unreadable += 1
    return {"bytes": counts, "unreadable_count": unreadable}


if __name__ == "__main__":
    import sys
    roots = [(Path(path), group) for path, group in json.loads(sys.argv[1])] if len(sys.argv) > 1 else [(Path("/home/agent"), "other"), (Path("/var/lib/cora"), "other"), (Path("/var/log"), "logs")]
    print(json.dumps(measure(roots)))
