import { readFile } from 'node:fs/promises';
import { inspectArtifacts } from './artifact-policy.mjs';
const record=JSON.parse(await readFile('reports/build-artifacts.json','utf8'));
const root=process.argv[2]??record.outputDir;
const inventory=await inspectArtifacts(root,record.files);
console.log(`Approved ${inventory.length} production files (${inventory.reduce((sum,f)=>sum+f.bytes,0)} bytes); hashes match the build allow-list.`);
