import {readFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {request} from './client.mjs';

const [socket,tokenFile,invoiceFile]=process.argv.slice(2);
if(!invoiceFile)throw new Error('Usage: node run.mjs SOCKET TOKEN_FILE SIGNED_INVOICE');
const invoice=JSON.parse(await readFile(invoiceFile,'utf8'));
let submitted;
for(let attempt=0;attempt<2;attempt++){
  try{submitted=await request(socket,tokenFile,{op:'submit',invoice});break;}
  catch(error){if(attempt===1)throw new Error(`Outcome unknown. Retain and retry this exact invoice: ${error.message}`);}
}
if(!submitted.ok)throw new Error(`Signer refused invoice: ${submitted.error}`);
let payment=submitted.result;
console.log(JSON.stringify(payment));
const initial=await request(socket,tokenFile,{op:'status',payment_id:payment.payment_id});
if(!initial.ok)throw new Error(initial.error);
payment=initial.result;
for(let poll=0;payment.state!=='confirmed' && poll<60;poll++){
  await setTimeout(5000);
  const response=await request(socket,tokenFile,{op:'status',payment_id:payment.payment_id});
  if(!response.ok)throw new Error(response.error);
  payment=response.result;
  console.log(JSON.stringify(payment));
}
if(payment.state!=='confirmed')throw new Error('Receipt remains pending. The agent will not create a replacement invoice or payment.');
