import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, rm, readdir, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendJournal, readBounded, MAX_JOURNAL_BYTES } from "../../mcp-server/storage.js";
import { parseJournal } from "../../mcp-server/lib.js";
test("concurrent journal writers across processes preserve each entry in atomic replacements", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"clipbraid-journal-")), file = path.join(root,"JOURNAL.md");
  try {
    const script = `import {appendJournal} from ${JSON.stringify(new URL("../../mcp-server/storage.js",import.meta.url).href)};
      await Promise.all(Array.from({length:4},(_,n)=>appendJournal(process.argv[1],process.argv[2]+n,'synthetic entry')));`;
    await Promise.all([
      ...Array.from({length:12},(_,n)=>appendJournal(file,`local${n}`,"synthetic entry")),
      ...Array.from({length:3},(_,n)=>promisify(execFile)(process.execPath,["--input-type=module","-e",script,file,`child${n}-`])),
    ]);
    const entries = parseJournal(await readFile(file,"utf8"));
    assert.equal(entries.length,24); assert.equal(new Set(entries.map(entry=>entry.title)).size,24);
    assert.deepEqual(await readdir(root),["JOURNAL.md"]);
    await writeFile(file,"x".repeat(MAX_JOURNAL_BYTES+1));
    await assert.rejects(()=>appendJournal(file,"blocked","body"),/read limit/);
    assert.equal((await readFile(file)).length,MAX_JOURNAL_BYTES+1);
    assert.deepEqual(await readdir(root),["JOURNAL.md"]);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test("log reads are bounded and fixed-path symlinks cannot redirect a read", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"clipbraid-log-")), file = path.join(root,"large.log");
  try {
    await writeFile(file,"x".repeat(1024*1024)+"\nlast line");
    const result = await readBounded(file,128,true);
    assert.equal(result.text,"last line"); assert.equal(result.truncated,true);
    await assert.rejects(()=>readBounded(file,128),/read limit/);
    await symlink(file,path.join(root,"redirect"));
    await assert.rejects(()=>readBounded(path.join(root,"redirect"),128,true));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("journal appends accept an explicitly trusted directory alias", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "clipbraid-journal-root-")));
  const physical = path.join(directory, "physical"), alias = path.join(directory, "alias");
  try {
    await mkdir(physical); await symlink(physical, alias, "dir");
    await appendJournal(path.join(alias, "JOURNAL.md"), "first entry", "synthetic body", "UTC", alias);
    await appendJournal(path.join(physical, "JOURNAL.md"), "second entry", "synthetic body", "UTC", physical);
    const entries = parseJournal(await readFile(path.join(physical, "JOURNAL.md"), "utf8"));
    assert.equal(entries.length, 2);
    assert.match(entries[0].title, /second entry/);
    assert.match(entries[1].title, /first entry/);
    assert.deepEqual(await readdir(physical), ["JOURNAL.md"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("explicit roots reject sibling paths, traversal and descendant directory links", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "clipbraid-storage-boundary-")));
  const root = path.join(directory, "root"), sibling = path.join(directory, "root-other");
  try {
    await mkdir(root); await mkdir(sibling);
    const outside = path.join(sibling, "JOURNAL.md");
    await writeFile(outside, "outside bytes");
    await assert.rejects(readBounded(outside, 128, false, root), /outside its allowed root/);
    const traversal = `${root}${path.sep}..${path.sep}root-other${path.sep}JOURNAL.md`;
    await assert.rejects(readBounded(traversal, 128, false, root), /outside its allowed root/);
    await symlink(sibling, path.join(root, "redirect"), "dir");
    await assert.rejects(appendJournal(path.join(root, "redirect/JOURNAL.md"), "blocked", "body", "UTC", root), /symlink/i);
    assert.equal(await readFile(outside, "utf8"), "outside bytes");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
