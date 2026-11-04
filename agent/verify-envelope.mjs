import {readFile} from 'node:fs/promises';
import {createPublicKey,verify} from 'node:crypto';

// Interop check for this schema: ASCII field names, safe integers, amounts as strings.
// This checks signature encoding, not whether envelope keys are trusted approvers.
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  if(typeof value==='number' && !Number.isSafeInteger(value))throw new Error('Unsafe integer');
  return value;
}
const [file,domain]=process.argv.slice(2);
const envelope=JSON.parse(await readFile(file,'utf8'));
const bytes=Buffer.from(`${domain}\0${JSON.stringify(canonical(envelope.payload))}`);
for(const approval of envelope.signatures){
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(approval.key,'hex')]),format:'der',type:'spki'});
  if(!verify(null,bytes,key,Buffer.from(approval.signature,'hex')))throw new Error('Rust/Node signature mismatch');
}
console.log(`Verified ${envelope.signatures.length} Rust signatures independently in Node.`);
