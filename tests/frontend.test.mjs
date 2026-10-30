import test from 'node:test';
import assert from 'node:assert/strict';
import {searchPeople, shareText, countdown, namePopupHeight} from '../public/shared.js';
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


test('name menu height shrinks with the visible keyboard viewport without hiding panned inputs',()=>{
  const input = {top:310, bottom:364};
  assert.equal(namePopupHeight(input, 320), 128);
  assert.equal(namePopupHeight({top:-20, bottom:34}, 320), 128, 'a shifted input coordinate does not suppress suggestions');
});

test('name menu is capped at a manageable height on large screens',()=>{
  assert.equal(namePopupHeight({top:600}, 1200), 200);
  assert.equal(namePopupHeight({top:600}, 844), 200);
});

test('name menu respects the space above an input inside a dialog',()=>{
  assert.equal(namePopupHeight({top:260}, 844, 150), 96);
  assert.equal(namePopupHeight({top:110}, 844, 0), 96, 'a dialog at the viewport origin is still constrained');
  assert.equal(namePopupHeight({top:560}, 844, 450), 96, 'panning the dialog and input together preserves available height');
});

test('name menu retains a usable minimum when viewport or dialog coordinates are tight',()=>{
  assert.equal(namePopupHeight({top:80}, 100), 64);
  assert.equal(namePopupHeight({top:80}, 844, 60), 64);
  assert.equal(namePopupHeight({top:80}, 844, 100), 64, 'inconsistent dialog coordinates never reduce the list to zero');
});
