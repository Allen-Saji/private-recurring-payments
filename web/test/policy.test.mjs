import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fundingRequest, formatZatoshis} from '../src/policy.mjs';
test('funding rejects mainnet or transparent sources and destinations',()=>{
  assert.throws(()=>fundingRequest('u1acd','utest1def'));
  assert.throws(()=>fundingRequest('utest1acd','tm123'));
  assert.throws(()=>fundingRequest('utest1acd','utest1acd'));
});
test('funding amount and source are fixed without floating point arithmetic',()=>{
  assert.deepEqual(fundingRequest('utest1acd','utest1def'), {to:'utest1acd',amount:'0.05',memo:'private-recurring:wallet-funding:v1',fundingSource:'shielded'});
  assert.equal(formatZatoshis('123456789'),'1.23456789');
  assert.equal(formatZatoshis(undefined),'Not synced');
});
