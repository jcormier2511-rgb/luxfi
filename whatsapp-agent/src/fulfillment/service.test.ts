import test from 'node:test';import assert from 'node:assert/strict';import {coverageMatches} from './service';
const wtb=(brand:string,model='',reference='')=>({brand,model,reference,location:'',price:null});
test('brand-only coverage matches broad and exact-reference WTBs',()=>{const c={brand:'Richard Mille'};assert.equal(coverageMatches(c,wtb('Richard Mille')),true);assert.equal(coverageMatches(c,wtb('Richard Mille','RM 67-02','RM67-02')),true)});
test('brand coverage rejects another brand',()=>assert.equal(coverageMatches({brand:'Richard Mille'},wtb('Rolex','Daytona')),false));
test('optional model and reference narrow coverage',()=>{assert.equal(coverageMatches({brand:'Rolex',model:'Daytona'},wtb('Rolex','Daytona')),true);assert.equal(coverageMatches({brand:'Rolex',model:'Daytona'},wtb('Rolex','Submariner')),false);assert.equal(coverageMatches({brand:'Richard Mille',reference:'RM 67-02'},wtb('Richard Mille','RM','RM67 02')),true)});
