import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainText, readingMinutes, renderMarkdown, slugify } from '../../src/lib/markdown.ts'

test('renders basic markdown', () => {
  const html = renderMarkdown('## Menu\n\n**Fresh** coffee\n\n- a\n- b')
  assert.match(html, /<h2>Menu<\/h2>/)
  assert.match(html, /<strong>Fresh<\/strong>/)
  assert.match(html, /<li>a<\/li>/)
})
test('strips scripts, event handlers and javascript: links', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="https://x.test/a.png" onerror="alert(1)">\n\n[x](javascript:alert(1))\n\n<iframe src="https://evil.test"></iframe>')
  assert.doesNotMatch(html, /script|onerror|javascript:|iframe/i)
  assert.match(html, /<img src="https:\/\/x\.test\/a\.png" loading="lazy" \/>/)
})
test('h1 becomes h2 and external links get safe rel', () => {
  const html = renderMarkdown('# Title\n\n[site](https://example.com)')
  assert.match(html, /<h2>Title<\/h2>/)
  assert.match(html, /rel="noopener noreferrer nofollow"/)
})
test('images must be https', () => {
  assert.doesNotMatch(renderMarkdown('![a](http://x.test/a.png)'), /<img/)
})
test('slugify', () => {
  assert.equal(slugify('Café & Bakery — Baner!'), 'cafe-and-bakery-baner')
  assert.equal(slugify('  --Hello   World--  '), 'hello-world')
  assert.match(slugify('x'.repeat(200)), /^x{80}$/)
})
test('plainText and reading time', () => {
  assert.equal(plainText('## Hi\n\nThere **you**', 50), 'Hi There you')
  assert.equal(plainText('word '.repeat(100), 20).length, 20)
  assert.equal(readingMinutes('w '.repeat(600)), 3)
})
