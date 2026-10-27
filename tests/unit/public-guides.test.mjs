import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {sourceIdentity} from '../../scripts/source-identity.mjs';
test('source archives bind approved user guides while excluding private notes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'clipbraid-guide-identity-'));
  try{
    await mkdir(path.join(root,'guides'));
    await writeFile(path.join(root,'README.md'),'Public entry');
    await writeFile(path.join(root,'guides/support.md'),'Approved support guide');
    await writeFile(path.join(root,'guides/internal-notes.md'),'Private notes');
    const first=sourceIdentity(root);
    assert(first.inputs.some(item=>item.path==='guides/support.md'));
    assert(!first.inputs.some(item=>item.path==='guides/internal-notes.md'));
    await writeFile(path.join(root,'guides/internal-notes.md'),'Changed private notes');assert.equal(sourceIdentity(root).sha256,first.sha256);
    await writeFile(path.join(root,'guides/support.md'),'Changed public limits');assert.notEqual(sourceIdentity(root).sha256,first.sha256);
  }finally{await rm(root,{recursive:true,force:true})}
});
