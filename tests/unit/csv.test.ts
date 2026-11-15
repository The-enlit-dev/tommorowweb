import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCsv } from '../../src/portal/lib.ts'

test('csv escapes quotes, commas and newlines', () => {
  assert.equal(toCsv([{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2' }]), 'a,b,c\n"x,y","say ""hi""","l1\nl2"')
})
test('csv neutralises formula injection', () => {
  assert.equal(toCsv([{ a: '=HYPERLINK("x")', b: '+91 98', c: '@cmd', d: '-2' }]), `a,b,c,d\n"'=HYPERLINK(""x"")",'+91 98,'@cmd,'-2`)
})
test('csv handles null, numbers and objects', () => {
  assert.equal(toCsv([{ a: null, b: 5, c: { k: 1 } }]), 'a,b,c\n,5,"{""k"":1}"')
  assert.equal(toCsv([]), '')
})
