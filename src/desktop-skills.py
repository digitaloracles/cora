import base64,hashlib,json,os,re,shutil,stat,sys,tempfile
HOME="/home/agent"
CANON=os.path.join(HOME,".agents","skills")
LINKS=[".claude/skills",".grok/skills",".hermes/skills",".gemini/skills"]
NAME=re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
op=sys.argv[1]
data=json.load(sys.stdin)
def name_ok(name):
  if not isinstance(name,str) or not NAME.match(name) or ".." in name: sys.exit("invalid skill name")
  return name
def digest(path):
  h=hashlib.sha256()
  with open(path,"rb") as handle:
    for chunk in iter(lambda: handle.read(65536),b""): h.update(chunk)
  return h.hexdigest()
def files_of(root,limit=400):
  out={}
  for base,dirs,names in os.walk(root,followlinks=False):
    dirs[:]=sorted(d for d in dirs if not os.path.islink(os.path.join(base,d)) and d not in (".git","node_modules"))
    for name in sorted(names):
      path=os.path.join(base,name)
      if os.path.islink(path) or not os.path.isfile(path): continue
      out[os.path.relpath(path,root)]=path
      if len(out)>=limit: return out
  return out
def frontmatter(path):
  try:
    with open(path,"r",encoding="utf-8",errors="replace") as handle: text=handle.read(65536)
  except OSError: return {}
  match=re.match(r"^---\s*\n(.*?)\n---",text,re.S)
  if not match: return {}
  out={}
  for line in match.group(1).splitlines():
    m=re.match(r"^(name|description):\s*(.*)$",line)
    if m: out[m.group(1)]=m.group(2).strip().strip("\"'")[:1024]
  return out
def link_state(name):
  target=os.path.realpath(os.path.join(CANON,name))
  out={}
  for rel in LINKS:
    path=os.path.join(HOME,rel,name)
    if os.path.islink(path): out[rel]="ok" if os.path.realpath(path)==target and os.path.isdir(target) else "other"
    elif os.path.isdir(path): out[rel]="copy"
    else: out[rel]="missing"
  return out
def same_tree(a,b):
  left=files_of(a);right=files_of(b)
  return left.keys()==right.keys() and all(digest(left[k])==digest(right[k]) for k in left)
def link(name):
  canonical=os.path.join(CANON,name)
  for rel in LINKS:
    folder=os.path.join(HOME,rel)
    os.makedirs(folder,exist_ok=True)
    path=os.path.join(folder,name)
    if os.path.islink(path): os.unlink(path)
    elif os.path.isdir(path) and same_tree(path,canonical): shutil.rmtree(path)
    elif os.path.exists(path): continue
    os.symlink(os.path.relpath(os.path.join(CANON,name),folder),path)
def check(expected):
  skills={}
  for name,files in expected.items():
    name_ok(name)
    root=os.path.join(CANON,name)
    if not os.path.isdir(root) or os.path.islink(root):
      skills[name]={"present":False,"missing":sorted(files),"changed":[],"extra":[],"links":link_state(name)}
      continue
    actual=files_of(root)
    missing=sorted(p for p in files if p not in actual)
    changed=sorted(p for p in files if p in actual and digest(actual[p])!=files[p])
    extra=sorted(p for p in actual if p not in files)
    skills[name]={"present":True,"missing":missing,"changed":changed,"extra":extra,"links":link_state(name)}
  found={}
  for rel in [".agents/skills"]+LINKS:
    folder=os.path.join(HOME,rel)
    if not os.path.isdir(folder): continue
    for name in sorted(os.listdir(folder)):
      path=os.path.join(folder,name)
      if name.startswith(".") or name in expected or not os.path.isfile(os.path.join(path,"SKILL.md")): continue
      entry=found.get(name)
      if entry is None:
        entry={"name":name,"where":[],"linked":[]}
        meta=frontmatter(os.path.join(path,"SKILL.md"))
        if "description" in meta: entry["description"]=meta["description"]
        if meta.get("name") and meta["name"]!=name: entry["declared"]=meta["name"]
        sizes=[os.path.getsize(item) for item in files_of(os.path.realpath(path),201).values()]
        if len(sizes)>200 or sum(sizes)>4*1024*1024 or any(size>2*1024*1024 for size in sizes): entry["problem"]="skill too large to adopt (200 files, 4 MB)"
        found[name]=entry
      (entry["linked"] if os.path.islink(path) else entry["where"]).append(rel)
  return {"skills":skills,"found":sorted(found.values(),key=lambda e:e["name"])[:100]}
def remove(names,everywhere):
  for name in names:
    name_ok(name)
    canonical=os.path.realpath(os.path.join(CANON,name))
    for rel in LINKS:
      path=os.path.join(HOME,rel,name)
      if os.path.islink(path):
        if os.path.realpath(path)==canonical or everywhere: os.unlink(path)
      elif os.path.isdir(path) and everywhere: shutil.rmtree(path)
    path=os.path.join(CANON,name)
    if os.path.islink(path): os.unlink(path)
    elif os.path.isdir(path): shutil.rmtree(path)
if op=="sync":
  os.makedirs(CANON,exist_ok=True)
  for skill in data.get("skills",[]):
    name=name_ok(skill["name"])
    temporary=tempfile.mkdtemp(prefix=".cora-",dir=CANON)
    for item in skill["files"]:
      rel=os.path.normpath(item["path"])
      if rel.startswith("..") or os.path.isabs(rel) or rel in (".",""): shutil.rmtree(temporary); sys.exit("invalid file path")
      path=os.path.join(temporary,rel)
      os.makedirs(os.path.dirname(path),exist_ok=True)
      with open(path,"wb") as handle: handle.write(base64.b64decode(item["data"]))
      os.chmod(path,0o755 if item.get("exec") else 0o644)
    os.chmod(temporary,0o755)
    dest=os.path.join(CANON,name)
    if os.path.islink(dest) or os.path.isfile(dest): os.unlink(dest)
    elif os.path.isdir(dest): shutil.rmtree(dest)
    os.rename(temporary,dest)
    link(name)
  remove(data.get("off",[]),False)
  print(json.dumps(check(data.get("expected",{}))))
elif op=="remove":
  remove(data.get("names",[]),data.get("everywhere"))
  print(json.dumps(check(data.get("expected",{}))))
elif op=="check":
  print(json.dumps(check(data.get("expected",{}))))
elif op=="read":
  name=name_ok(data["name"])
  root=None
  for rel in [".agents/skills"]+LINKS:
    path=os.path.join(HOME,rel,name)
    if os.path.isfile(os.path.join(path,"SKILL.md")): root=os.path.realpath(path); break
  if not root or not (root+"/").startswith(os.path.realpath(HOME)+"/"): sys.exit("skill not found on the desktop")
  out=[];total=0
  for rel,path in files_of(root,201).items():
    size=os.path.getsize(path);total+=size
    if len(out)>=200 or size>2*1024*1024 or total>4*1024*1024: sys.exit("skill too large to adopt (200 files, 4 MB)")
    with open(path,"rb") as handle: out.append({"path":rel,"data":base64.b64encode(handle.read()).decode(),"exec":bool(os.stat(path).st_mode&stat.S_IXUSR)})
  print(json.dumps({"files":out}))
else: sys.exit("unknown operation")
