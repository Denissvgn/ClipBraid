import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
mkdirSync('reports',{recursive:true});
const run=spawnSync('npm',['audit','--json'],{encoding:'utf8',timeout:60000});
let audit;try{audit=JSON.parse(run.stdout);}catch{throw new Error(`Dependency audit did not return JSON: ${run.error?.message??run.stderr}`);}
writeFileSync('reports/dependency-audit.json',JSON.stringify(audit,null,2)+'\n');
if(!audit.metadata||audit.error)throw new Error('Dependency audit unavailable; see reports/dependency-audit.json');
const lockBytes=readFileSync('package-lock.json');const lock=JSON.parse(lockBytes);
const packages=Object.entries(lock.packages).filter(([path])=>path).map(([path,p])=>({path,version:p.version,license:p.license??'unknown',dev:!!p.dev,optional:!!p.optional}));
writeFileSync('reports/dependency-licenses.json',JSON.stringify({recordedAt:new Date().toISOString(),lockfileSha256:createHash('sha256').update(lockBytes).digest('hex'),packages,boundary:'Package metadata only; compiled codecs, remote fonts and browser binaries need upstream license review.'},null,2)+'\n');
console.log(JSON.stringify({vulnerabilities:audit.metadata.vulnerabilities,licenseMetadataPackages:packages.length,unknownLicenses:packages.filter(p=>p.license==='unknown').length}));
process.exitCode=run.status??1;
