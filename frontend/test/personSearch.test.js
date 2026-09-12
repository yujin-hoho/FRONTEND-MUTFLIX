import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPersonNameMatchScore,
  getPersonSearchQueryVariants,
  rankPersonSearchResults,
} from '../src/utils/personSearch.js'

test('generates a combined Korean romanization fallback', () => {
  const variants = getPersonSearchQueryVariants('Yu Jae Seok')

  assert.equal(variants[0], 'yu jae seok')
  assert.ok(variants.includes('yoo jae suk'))
  assert.ok(variants.length <= 6)
})

test('treats equivalent Korean romanizations as the same full name', () => {
  assert.equal(getPersonNameMatchScore('Yu Jae Seok', 'Yoo Jae-suk'), 1000)
  assert.equal(getPersonNameMatchScore('Kim Soo Hyun', 'Gim Soo-hyeon'), 1000)
})

test('supports a matching partial person name without accepting unrelated names', () => {
  assert.equal(getPersonNameMatchScore('Jae Seok', 'Yoo Jae-suk'), 900)
  assert.equal(getPersonNameMatchScore('Yu Jae Seok', 'Yoo Ah-in'), 0)
  assert.equal(getPersonNameMatchScore('Park Seo Joon', 'Park Seo-jin'), 0)
})

test('filters unrelated results, ranks matching people, and deduplicates TMDB ids', () => {
  const people = rankPersonSearchResults([
    { results: [{ id: 1, name: 'Yoo Ah-in' }, { id: 2, name: 'Yoo Jae-suk' }] },
    { results: [{ id: 2, name: 'Yoo Jae Suk' }, { id: 3, name: 'Yu Jae Seok' }] },
  ], 'Yu Jae Seok')

  assert.deepEqual(people.map(({ id }) => id), [2, 3])
})

test('leaves ordinary names as a single query', () => {
  assert.deepEqual(getPersonSearchQueryVariants('Tom Hanks'), ['tom hanks'])
})
