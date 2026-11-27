import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the desktop removes only old owned cache files, preserves dependencies and skips active Go builds", () => {
  const worker = fileURLToPath(new URL("../src/desktop-cache.py", import.meta.url));
  const script = `
import os, runpy, sys, tempfile, time
from pathlib import Path
clean = runpy.run_path(sys.argv[1])['clean']
with tempfile.TemporaryDirectory() as root:
    home = Path(root)
    bucket = home / '.cache/go-build/ab'
    project = home / 'work/project'
    babel = project / 'node_modules/.cache/babel-loader'
    bucket.mkdir(parents=True)
    babel.mkdir(parents=True)
    (project / 'package.json').touch()
    old = bucket / ('ab'*32 + '-d')
    recent = bucket / ('ab'*32 + '-a')
    built = babel / ('cd'*32 + '.json.gz')
    source = project / 'node_modules/source.js'
    linked = babel / ('ab'*32 + '.json')
    hard = babel / ('ef'*32 + '.json')
    for path in (old, recent, built, source):
        path.write_bytes(b'data')
    stale = time.time() - 9*86400
    for path in (old, built, source):
        os.utime(path, (stale, stale))
    linked.symlink_to(source)
    os.link(source, hard)
    assert clean(root, False, set())['go']['bytes'] == 4 and old.exists()
    run = clean(root, True, {'go'})
    assert run['go']['busy'] and old.exists() and run['babel']['bytes'] == 4 and not built.exists()
    assert clean(root, True, set())['go']['bytes'] == 4 and not old.exists()
    assert recent.exists() and linked.is_symlink() and hard.exists() and source.read_bytes() == b'data'
    assert sum(c['bytes'] for c in clean(root, True, set()).values()) == 0
`;
  const result = spawnSync("python3", ["-I", "-c", script, worker], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
