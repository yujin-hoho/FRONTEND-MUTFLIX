import assert from 'node:assert/strict'
import test from 'node:test'
import { findCatalogItemForHistory } from './historyCatalog.js'

const first = { folder_name: 'First Show', source: 'server-a' }
const watched = { folder_name: 'Watched Show', source: 'server-a' }

test('shared server cannot select the first catalog item after refresh', () => {
  const history = { series_title: 'Watched Show', source: 'server-a' }
  assert.equal(findCatalogItemForHistory(history, [first, watched]), watched)
  assert.equal(findCatalogItemForHistory(history, [watched, first]), watched)
})

test('an incomplete catalog never falls back to another title on the same server', () => {
  const history = { series_title: 'Watched Show', source: 'server-a' }
  assert.equal(findCatalogItemForHistory(history, []), null)
  assert.equal(findCatalogItemForHistory(history, [first]), null)
  assert.equal(findCatalogItemForHistory(history, [first, watched]), watched)
  assert.equal(findCatalogItemForHistory({ source: 'server-a' }, [first]), null)
})

test('exact series path takes priority over a matching display title', () => {
  const correct = { path: 'series/Watched', title: 'Renamed Show' }
  assert.equal(findCatalogItemForHistory({ series_path: '/series/Watched/', series_title: 'First Show' }, [first, correct]), correct)
})

test('movie titles match without a series path', () => {
  const movie = { tmdb_title: 'A Movie', source: 'server-a' }
  assert.equal(findCatalogItemForHistory({ media_title: 'A Movie', source: 'server-a' }, [first, movie]), movie)
})

test('ambiguous titles do not depend on catalog order', () => {
  assert.equal(findCatalogItemForHistory({ series_title: 'Watched Show' }, [watched, { ...watched, source: 'server-b' }]), null)
})

test('title matching preserves accent and punctuation normalization', () => {
  const item = { title: 'Café: Stories' }
  assert.equal(findCatalogItemForHistory({ series_title: 'cafe stories' }, [first, item]), item)
})
