import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repositoryName,filterCatalog,dependencyStatus} from '../src/catalog-tools.mjs';
test('repository input accepts GitHub URL only',()=>{assert.equal(repositoryName('https://github.com/Owner/Repo/'),'owner/repo'); for(const v of ['https://evil.com/a/b','a/..','a/b?x=1']) assert.throws(()=>repositoryName(v));});
test('catalog filters by Cyrillic search and source',()=>{const e={name:'Опыт',description:'',path:'a.js',repo:'a/b',author:'a',license:'MIT'};assert.deepEqual(filterCatalog([e],'ОПЫТ','a/b','MIT'),[e]);assert.deepEqual(filterCatalog([e],'','a/c',''),[]);});
test('dependency status never borrows inventory from another world',()=>{const s={serverOrigin:'http://localhost:30000',worldId:'a',modules:[{id:'tagger',version:'1',active:false},{id:'sequencer',version:'2',active:true}]};assert.deepEqual(dependencyStatus(['tagger','sequencer','missing'],s,s.serverOrigin,'a').map(x=>x.status),['missing','active','inactive']);assert.equal(dependencyStatus(['tagger'],s,s.serverOrigin,'b')[0].status,'unknown');});
