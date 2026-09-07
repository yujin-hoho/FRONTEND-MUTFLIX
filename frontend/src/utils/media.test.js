import assert from 'node:assert/strict'
import test from 'node:test'
import { selectBackdropCandidate } from './artwork.js'

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
