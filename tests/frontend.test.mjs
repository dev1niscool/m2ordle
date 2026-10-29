import test from 'node:test';
import assert from 'node:assert/strict';
import {searchPeople, shareText, countdown, namePopupLayout} from '../public/shared.js';
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

function assertPopupFits(layout, bounds, contentHeight = 230) {
  const height = Math.min(contentHeight, layout.maxHeight);
  assert.ok(layout.left >= bounds.left, 'menu stays inside the visible left edge');
  assert.ok(layout.left + layout.width <= bounds.right, 'menu stays inside the visible right edge');
  assert.ok(layout.top >= bounds.top, 'menu stays inside the visible top edge');
  assert.ok(layout.top + height <= bounds.bottom, 'menu stays above the keyboard or dialog bottom');
  assert.ok(layout.width > 0 && layout.maxHeight > 0, 'menu retains usable space');
}

test('name menu opens above an input near the keyboard without overflowing the visible viewport',()=>{
  const bounds = {left:0, top:0, right:390, bottom:400};
  const input = {left:22, top:310, right:268, bottom:364, width:246};
  const layout = namePopupLayout(input, bounds, 1200);
  assert.equal(layout.above, true);
  assert.equal(layout.width, input.width);
  assert.ok(layout.top + layout.maxHeight < input.top, 'menu does not cover the input');
  assertPopupFits(layout, bounds, 1200);
});

test('name menu uses space below the input when a full list fits',()=>{
  const bounds = {left:0, top:0, right:390, bottom:844};
  const input = {left:22, top:100, right:268, bottom:154, width:246};
  const layout = namePopupLayout(input, bounds);
  assert.equal(layout.above, false);
  assert.ok(layout.top > input.bottom);
  assertPopupFits(layout, bounds);
});

test('name menu respects a visual viewport panned down by the phone keyboard',()=>{
  const bounds = {left:0, top:300, right:390, bottom:650};
  const input = {left:22, top:450, right:272, bottom:500, width:250};
  const layout = namePopupLayout(input, bounds, 1200);
  assert.equal(layout.above, false, 'space outside the visible top edge is not counted');
  assert.ok(layout.maxHeight < 230, 'long results scroll within the available space');
  assertPopupFits(layout, bounds, 1200);
});

test('name menu stays inside narrow dialog bounds even when its anchor is wider',()=>{
  const bounds = {left:40, top:170, right:350, bottom:560};
  const input = {left:20, top:400, right:420, bottom:450, width:400};
  const layout = namePopupLayout(input, bounds, 1200);
  assert.ok(layout.width < input.width);
  assertPopupFits(layout, bounds, 1200);
});

test('changing from many names to one no-match row does not flip the menu side',()=>{
  const bounds = {left:0, top:0, right:390, bottom:420};
  const input = {left:22, top:250, right:268, bottom:300, width:246};
  const many = namePopupLayout(input, bounds, 1200);
  const noMatch = namePopupLayout(input, bounds, 54);
  assert.equal(many.above, true);
  assert.equal(noMatch.above, many.above);
  assert.equal(noMatch.left, many.left);
  assert.equal(noMatch.width, many.width);
  assert.equal(noMatch.top + Math.min(54, noMatch.maxHeight), many.top + many.maxHeight, 'both menus remain anchored just above the input');
  assertPopupFits(many, bounds, 1200);
  assertPopupFits(noMatch, bounds, 54);
});

test('name menu accounts for horizontal visual-viewport offsets',()=>{
  const bounds = {left:120, top:20, right:360, bottom:500};
  const input = {left:80, top:100, right:340, bottom:154, width:260};
  const layout = namePopupLayout(input, bounds);
  assert.ok(layout.left > input.left);
  assert.ok(layout.width < input.width);
  assertPopupFits(layout, bounds);
});
