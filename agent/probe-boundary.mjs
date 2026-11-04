import {request} from './client.mjs';
import net from 'node:net';
const [socket,tokenFile]=process.argv.slice(2);
for(const op of ['install','revoke','sign','export_seed']){
  let rejected=false;
  try{const result=await request(socket,tokenFile,{op});rejected=result.ok===false;}catch{rejected=true;}
  if(!rejected)throw new Error(`Forbidden operation accepted: ${op}`);
  console.log(`Denied execution-client operation: ${op}`);
}

async function rejectedFrame(bytes){
  await new Promise((resolve,reject)=>{
    const connection=net.createConnection(socket);
    connection.setTimeout(5000,()=>connection.destroy(new Error('Boundary probe timed out')));
    connection.on('connect',()=>connection.write(bytes));
    connection.on('data',()=>{connection.destroy();reject(new Error('Unauthorized frame received a response'));});
    connection.on('error',error=>{if(error.code==='ECONNRESET')resolve();else reject(error);});
    connection.on('end',resolve);
  });
}
const unauthorized=Buffer.from(JSON.stringify({token:'0'.repeat(64),action:{op:'status',payment_id:'0'.repeat(64)}}));
const header=Buffer.alloc(4);header.writeUInt32BE(unauthorized.length);
await rejectedFrame(Buffer.concat([header,unauthorized]));
console.log('Denied invalid execution credential.');
const oversized=Buffer.alloc(4);oversized.writeUInt32BE(32769);
await rejectedFrame(oversized);
console.log('Denied oversized request before allocating its body.');
