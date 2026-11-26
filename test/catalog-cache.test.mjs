import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readCatalog,writeCatalog,replaceRepository,dependencyIds} from '../src/catalog-cache.mjs';
const entry={name:'Тест',description:'',repo:'a/b',path:'x.js',commit:'a'.repeat(40),author:'a',license:'MIT',compatibility:'unknown',code:'\ufeff// x\r\n'};
test('catalog cache roundtrip and invalid data',()=>{let raw=null;const storage={getItem:()=>raw,setItem:(_,v)=>raw=v};assert.deepEqual(readCatalog(storage),[]);writeCatalog(storage,[entry]);assert.deepEqual(readCatalog(storage),[entry]);raw='{}';assert.throws(()=>readCatalog(storage));});
test('refresh keeps code only for same revision',()=>{assert.equal(replaceRepository([entry],'a/b',[entry])[0].code,entry.code);assert.equal(replaceRepository([entry],'a/b',[{...entry,commit:'b'.repeat(40)}])[0].code,undefined);});
test('manual module ids',()=>{assert.deepEqual(dependencyIds('tagger, sequencer tagger'),['sequencer','tagger']);assert.throws(()=>dependencyIds('bad/id'));});
