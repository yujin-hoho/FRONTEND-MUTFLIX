import assert from 'node:assert/strict'
import test from 'node:test'
import { selectBackdropCandidate, shouldPreferBackdropCandidate } from './artwork.js'

test('resolved TMDB backdrop replaces a temporary server backdrop', () => {
  const candidate = selectBackdropCandidate({
    backdrop_url: '/backdrops/default-series.jpg',
    tmdb_backdrop_path: '/real-landscape.jpg',
  })

  assert.deepEqual(candidate, { kind: 'tmdb', path: '/real-landscape.jpg' })
})

test('explicit server backdrop selection remains above TMDB metadata', () => {
  const candidate = selectBackdropCandidate({
    primary_backdrop_url: '/backdrops/selected.jpg',
    tmdb_backdrop_path: '/tmdb-landscape.jpg',
  })

  assert.deepEqual(candidate, { kind: 'server', path: '/backdrops/selected.jpg' })
})

test('temporary server backdrop remains available before metadata resolves', () => {
  const candidate = selectBackdropCandidate({ backdrop_url: '/backdrops/default-series.jpg' })

  assert.deepEqual(candidate, { kind: 'server', path: '/backdrops/default-series.jpg' })
})

test('resolved TMDB backdrop is not replaced by generic server backdrop choices', () => {
  const item = {
    all_backdrop_urls: ['/backdrops/default-series.jpg'],
    backdrop_url: '/backdrops/default-series.jpg',
    tmdb_backdrop_path: '/real-landscape.jpg',
  }

  assert.equal(shouldPreferBackdropCandidate(item), true)
  assert.deepEqual(selectBackdropCandidate(item), { kind: 'tmdb', path: '/real-landscape.jpg' })
})

test('explicitly selected server backdrop stays above TMDB and backdrop choices', () => {
  const item = {
    all_backdrop_urls: ['/backdrops/default-series.jpg'],
    primary_backdrop_url: '/backdrops/selected.jpg',
    tmdb_backdrop_path: '/real-landscape.jpg',
  }

  assert.equal(shouldPreferBackdropCandidate(item), true)
  assert.deepEqual(selectBackdropCandidate(item), { kind: 'server', path: '/backdrops/selected.jpg' })
})
