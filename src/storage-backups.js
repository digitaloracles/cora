import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const nightly = /^(?:cora-(\d{4}-\d{2}-\d{2})\.db|brain-(\d{4}-\d{2}-\d{2})\.json)$/;

function files(folder) {
  if (!existsSync(folder)) return [];
  if (!lstatSync(folder).isDirectory()) throw new Error("Invalid nightly backup directory");
  return readdirSync(folder).sort().flatMap(name => {
    const match = nightly.exec(name);
    if (!match) return [];
    const path = join(folder, name);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !stat.size) throw new Error("Invalid nightly backup: " + name);
    return [{ name, path, kind: match[1] ? "database" : "brain", day: match[1] || match[2], stat }];
  });
}

function readDatabase(path, read) {
  if (["-wal", "-shm", "-journal"].some(ext => existsSync(path + ext))) throw new Error("Unsettled nightly database");
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

function validate(copy, timezone) {
  if (copy.kind === "database") {
    readDatabase(copy.path, db => {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
      if (!["agents", "memories", "activity"].every(t => tables.includes(t)) ||
          db.prepare("PRAGMA integrity_check").all().some(row => row.integrity_check !== "ok")) throw new Error("Invalid nightly database: " + copy.name);
    });
    return;
  }
  const data = JSON.parse(readFileSync(copy.path, "utf8"));
  const complete = entry => ["pages", "notes", "revisions", "state"].every(key => Array.isArray(entry?.[key]));
  const owners = data.owners;
  const valid = owners === undefined ? complete(data) : Array.isArray(owners) && owners.length &&
    new Set(owners.map(o => o.id)).size === owners.length && owners.every(o => typeof o.id === "string" && o.id && complete(o.data));
  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(new Date(data.at));
  if (!valid || stamp !== copy.day) throw new Error("Incomplete nightly Brain export: " + copy.name);
}

export function rotateBackups({ folder, day, timezone, keep, brain, preview }) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 90) throw new Error("Invalid backup retention");
  const copies = files(folder).filter(copy => brain || copy.kind === "database");
  const expired = [];
  for (const kind of brain ? ["database", "brain"] : ["database"]) {
    const group = copies.filter(copy => copy.kind === kind);
    if (group.at(-1)?.day !== day) throw new Error("Today's nightly backup is missing: " + kind);
    expired.push(...group.slice(0, -keep));
  }
  for (const copy of copies) validate(copy, timezone);
  for (const { path, stat } of copies) {
    const now = lstatSync(path, { bigint: true });
    if (now.ino !== stat.ino || now.dev !== stat.dev || now.ctimeNs !== stat.ctimeNs) throw new Error("Backup changed during validation");
  }
  if (!preview) for (const copy of expired) unlinkSync(copy.path);
  return { validated: copies.length, expired: expired.length, bytes: expired.reduce((n, f) => n + Number(f.stat.size), 0), preview };
}

// Old files can still belong to a commit in a retained database, even after a missed night.
export function retainedArtifactTrees(folder) {
  const trees = new Set();
  for (const copy of files(folder).filter(f => f.kind === "database")) {
    readDatabase(copy.path, db => {
      for (const row of db.prepare("SELECT DISTINCT json_extract(data, '$.tree') AS tree FROM artifact_commits").iterate()) {
        if (row.tree) trees.add(row.tree);
      }
    });
  }
  return trees;
}
