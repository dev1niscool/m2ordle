import test from 'node:test';
import assert from 'node:assert/strict';
import {searchPeople, shareText, countdown} from '../public/shared.js';
test('autocomplete matches first and last word prefixes, accents, and multiword names',()=>{
  const people=[{id:'a',name:'John Smith'},{id:'b',name:'José Jones'},{id:'c',name:'Amy Johnson'}];
  assert.deepEqual(searchPeople(people,'jo').map(p=>p.id),['a','b','c']);
  assert.deepEqual(searchPeople(people,'jose jo').map(p=>p.id),['b']);
  assert.deepEqual(searchPeople(people,''),[]);
  assert.deepEqual(searchPeople(people,'hn'),[]);
});
test('share output always uses five squares and the specified public URL',()=>{
  assert.equal(shareText({number:1,guesses:[{correct:true}]}),'M2ordle #1\n🏥 🟩 ⬛ ⬛ ⬛ ⬛\n\nhttps://dev1niscool.github.io/m2ordle');
  assert.match(shareText({number:2,guesses:Array(5).fill({correct:false})}),/🏥 🟥 🟥 🟥 🟥 🟥/);
});
test('countdown supports a 25-hour DST day and clamps expired time',()=>{
  assert.equal(countdown('2026-11-02T06:00:00Z',Date.parse('2026-11-01T05:00:00Z')),'25:00:00');
  assert.equal(countdown('2026-01-01',Date.parse('2026-01-02')),'00:00:00');
});
