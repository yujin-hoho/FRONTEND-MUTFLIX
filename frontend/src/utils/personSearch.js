// Conservative equivalence groups for common Korean-name romanization variants.
// These are deliberately syllable-based: broad phonetic substitutions make
// person search return unrelated people too easily.
const KOREAN_ROMANIZATION_GROUPS = [
  ['yu', 'yoo'],
  ['u', 'woo'],
  ['seok', 'suk'],
  ['jeong', 'jung'],
  ['seong', 'sung'],
  ['hyeon', 'hyun'],
  ['gwon', 'kwon'],
  ['gu', 'koo'],
  ['gim', 'kim'],
  ['bak', 'park'],
  ['i', 'lee', 'yi'],
  ['im', 'lim'],
  ['no', 'roh'],
  ['si', 'shi'],
]

const romanizationGroupByToken = new Map(
  KOREAN_ROMANIZATION_GROUPS.flatMap((group) => group.map((token) => [token, group])),
)

const canonicalRomanizationByToken = new Map(
  KOREAN_ROMANIZATION_GROUPS.flatMap((group) => group.map((token) => [token, group[0]])),
)

function normalizePersonSearchQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

export function getPersonSearchQueryVariants(query, { limit = 6 } = {}) {
  const normalizedQuery = normalizePersonSearchQuery(query)
  if (!normalizedQuery) return []

  const tokens = normalizedQuery.split(' ')
  const variants = [normalizedQuery]
  const seen = new Set(variants)

  // Try one changed syllable first, then combinations. This makes useful
  // variants fit within a small request budget (for example Yu/Yoo + Seok/Suk).
  tokens.forEach((token, tokenIndex) => {
    const alternatives = romanizationGroupByToken.get(token) || []
    alternatives.forEach((alternative) => {
      addVariant(tokens, [[tokenIndex, alternative]], variants, seen, limit)
    })
  })

  for (let firstIndex = 0; firstIndex < tokens.length && variants.length < limit; firstIndex += 1) {
    const firstAlternatives = romanizationGroupByToken.get(tokens[firstIndex]) || []
    for (let secondIndex = firstIndex + 1; secondIndex < tokens.length && variants.length < limit; secondIndex += 1) {
      const secondAlternatives = romanizationGroupByToken.get(tokens[secondIndex]) || []
      firstAlternatives.forEach((firstAlternative) => {
        secondAlternatives.forEach((secondAlternative) => {
          addVariant(tokens, [
            [firstIndex, firstAlternative],
            [secondIndex, secondAlternative],
          ], variants, seen, limit)
        })
      })
    }
  }

  return variants.slice(0, limit)
}

export function getPersonNameMatchScore(query, name) {
  const queryTokens = getCanonicalPersonNameTokens(query)
  const nameTokens = getCanonicalPersonNameTokens(name)
  if (!queryTokens.length || !nameTokens.length || queryTokens.length > nameTokens.length) return 0

  const compactQuery = queryTokens.join('')
  const compactName = nameTokens.join('')
  if (compactQuery === compactName) return 1000
  if (containsTokenSequence(nameTokens, queryTokens)) return 900
  if (queryTokens.every((token) => nameTokens.includes(token))) return 800
  return 0
}

export function rankPersonSearchResults(pages, query) {
  const candidatesById = new Map()

  pages.forEach((page, pageIndex) => {
    const results = Array.isArray(page?.results) ? page.results : []
    results.forEach((person, resultIndex) => {
      if (!person?.id) return
      const matchScore = getPersonNameMatchScore(query, person.name)
      if (!matchScore) return

      const candidate = { matchScore, pageIndex, person, resultIndex }
      const existing = candidatesById.get(person.id)
      if (!existing || comparePersonCandidates(candidate, existing) < 0) {
        candidatesById.set(person.id, candidate)
      }
    })
  })

  return [...candidatesById.values()]
    .sort(comparePersonCandidates)
    .map(({ person }) => person)
}

function getCanonicalPersonNameTokens(value) {
  const normalized = normalizePersonSearchQuery(value)
  if (!normalized) return []
  return normalized
    .split(' ')
    .filter(Boolean)
    .map((token) => canonicalRomanizationByToken.get(token) || token)
}

function containsTokenSequence(candidateTokens, queryTokens) {
  return candidateTokens.some((_, startIndex) => (
    queryTokens.every((token, queryIndex) => candidateTokens[startIndex + queryIndex] === token)
  ))
}

function addVariant(tokens, replacements, variants, seen, limit) {
  if (variants.length >= limit) return
  const variantTokens = [...tokens]
  replacements.forEach(([index, replacement]) => {
    variantTokens[index] = replacement
  })
  if (variantTokens.some((token) => token.length < 2)) return
  const variant = variantTokens.join(' ')
  if (seen.has(variant)) return
  seen.add(variant)
  variants.push(variant)
}

function comparePersonCandidates(first, second) {
  return second.matchScore - first.matchScore
    || first.pageIndex - second.pageIndex
    || first.resultIndex - second.resultIndex
    || Number(second.person.popularity || 0) - Number(first.person.popularity || 0)
}
