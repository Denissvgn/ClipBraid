import { build } from 'vite';
import { mkdtemp, writeFile, readFile, readdir, lstat, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temporary=await mkdtemp(path.join(tmpdir(),'clipbraid-build-isolation-'));
const note=path.resolve('build-isolation-private-note.md'),marker='SYNTHETIC_PRIVATE_BUILD_INPUT_7f31';
const checks=[];
const inventory=async directory=>{
  try{
    const files=[];for(const entry of await readdir(directory,{withFileTypes:true})){
      const name=path.join(directory,entry.name);if(entry.isDirectory())files.push(...await inventory(name));else files.push(name);
    }return files;
  }
  catch(error){if(error.code==='ENOENT')return [];throw error}
};
try{
  await writeFile(note,marker,{flag:'wx'});
  const sourceOutput=path.join(temporary,'source');
  await assert.rejects(build({logLevel:'silent',build:{outDir:sourceOutput,emptyOutDir:true},plugins:[{
    name:'synthetic-private-import',enforce:'pre',transform(code,id){if(id===path.resolve('App.tsx'))return `${code}\nimport privateNote from ${JSON.stringify(note+'?raw')}; console.log(privateNote);`},
  }]}),/Non-product/);
  assert.equal((await inventory(sourceOutput)).length,0);checks.push('private import rejected before emission');
  const assetOutput=path.join(temporary,'asset');
  await assert.rejects(build({logLevel:'silent',build:{outDir:assetOutput,emptyOutDir:true},plugins:[{
    name:'synthetic-private-asset',generateBundle(){this.emitFile({type:'asset',fileName:'user-project.json',source:marker})},
  }]}),/Unapproved artifact/);
  assert.equal((await inventory(assetOutput)).length,0);checks.push('unapproved asset rejected before emission');
  const real=path.join(temporary,'existing');await mkdir(real);await writeFile(path.join(real,'keep.txt'),marker);
  const linked=path.join(temporary,'linked');await symlink(real,linked,'dir');
  await assert.rejects(build({logLevel:'silent',build:{outDir:linked,emptyOutDir:true}}),/symlink rejected/);
  assert.equal(await readFile(path.join(real,'keep.txt'),'utf8'),marker);assert.equal((await lstat(linked)).isSymbolicLink(),true);
  checks.push('output symlink rejected before clearing/writing');
  await mkdir('reports',{recursive:true});await writeFile('reports/build-isolation.json',JSON.stringify({status:'passed',checks},null,2)+'\n');
  console.log(`Build isolation: ${checks.length} negative integration checks passed.`);
}finally{await rm(note,{force:true});await rm(temporary,{recursive:true,force:true})}
