import assert from 'node:assert'
import { describe, test } from 'node:test'
import semver from 'semver'
import { parseVersionRange } from './parse'
import { compareVersionDiff, computeStatus, getMinVersionFromRange } from './validate'

function assertDefined<T>(value: T | null | undefined, msg = 'Expected value to be defined'): T {
  assert.ok(value != null, msg)
  return value
}

describe('getMinVersionFromRange', () => {
  test('extracts min version from caret range (^1.1.0)', () => {
    const range = assertDefined(parseVersionRange('1.1.0'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '1.1.0')
  })

  test('extracts min version from explicit caret (^2.0.0)', () => {
    const range = assertDefined(parseVersionRange('^2.0.0'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '2.0.0')
  })

  test('extracts min version from tilde range (~1.2.3)', () => {
    const range = assertDefined(parseVersionRange('~1.2.3'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '1.2.3')
  })

  test('extracts min version from >= range', () => {
    const range = assertDefined(parseVersionRange('>=1.0.0'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '1.0.0')
  })

  test('extracts min version from complex range (>=1.0.0, <2.0.0)', () => {
    const range = assertDefined(parseVersionRange('>=1.0.0, <2.0.0'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '1.0.0')
  })

  test('returns 0.0.0 for short version "0" (no explicit lower bound)', () => {
    // "0" becomes ^0 which is <1.0.0-0 (no explicit >=0.0.0)
    const range = assertDefined(parseVersionRange('0'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '0.0.0')
  })

  test('extracts min version from short version "0.1"', () => {
    // "0.1" becomes ^0.1 which is >=0.1.0 <0.2.0-0
    const range = assertDefined(parseVersionRange('0.1'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '0.1.0')
  })

  test('extracts min version from short version "1"', () => {
    // "1" becomes ^1 which is >=1.0.0 <2.0.0-0
    const range = assertDefined(parseVersionRange('1'))
    const min = getMinVersionFromRange(range)
    assert.strictEqual(min?.version, '1.0.0')
  })
})

describe('compareVersionDiff', () => {
  test('returns "latest" when versions are equal', () => {
    const current = assertDefined(semver.parse('1.2.3'))
    const target = assertDefined(semver.parse('1.2.3'))
    assert.strictEqual(compareVersionDiff(current, target), 'latest')
  })

  test('returns "latest" when current is newer', () => {
    const current = assertDefined(semver.parse('2.0.0'))
    const target = assertDefined(semver.parse('1.2.3'))
    assert.strictEqual(compareVersionDiff(current, target), 'latest')
  })

  test('returns "patch-behind" for patch difference (1.2.3 vs 1.2.4)', () => {
    const current = assertDefined(semver.parse('1.2.3'))
    const target = assertDefined(semver.parse('1.2.4'))
    assert.strictEqual(compareVersionDiff(current, target), 'patch-behind')
  })

  test('returns "minor-behind" for minor difference (1.1.0 vs 1.2.3)', () => {
    const current = assertDefined(semver.parse('1.1.0'))
    const target = assertDefined(semver.parse('1.2.3'))
    assert.strictEqual(compareVersionDiff(current, target), 'minor-behind')
  })

  test('returns "major-behind" for major difference (1.2.3 vs 2.0.0)', () => {
    const current = assertDefined(semver.parse('1.2.3'))
    const target = assertDefined(semver.parse('2.0.0'))
    assert.strictEqual(compareVersionDiff(current, target), 'major-behind')
  })

  test('returns "patch-behind" for prerelease difference (1.0.0-alpha vs 1.0.0)', () => {
    const current = assertDefined(semver.parse('1.0.0-alpha'))
    const target = assertDefined(semver.parse('1.0.0'))
    assert.strictEqual(compareVersionDiff(current, target), 'patch-behind')
  })
})

describe('computeStatus', () => {
  test('returns "latest" when specified version equals latest', () => {
    const range = assertDefined(parseVersionRange('1.2.3'))
    const latest = assertDefined(semver.parse('1.2.3'))
    assert.strictEqual(computeStatus(range, latest, latest), 'latest')
  })

  test('returns "latest" for 1.1.0 when latestStable 1.2.3 satisfies range ^1.1.0', () => {
    // "1.1.0" becomes ^1.1.0 which means >=1.1.0 <2.0.0, and 1.2.3 is in that range
    const range = assertDefined(parseVersionRange('1.1.0'))
    const latest = assertDefined(semver.parse('1.2.3'))
    assert.strictEqual(computeStatus(range, latest, latest), 'latest')
  })

  test('returns "latest" for 1.2.0 when latestStable 1.2.3 satisfies range ^1.2.0', () => {
    // "1.2.0" becomes ^1.2.0 which means >=1.2.0 <2.0.0, and 1.2.3 is in that range
    const range = assertDefined(parseVersionRange('1.2.0'))
    const latest = assertDefined(semver.parse('1.2.3'))
    assert.strictEqual(computeStatus(range, latest, latest), 'latest')
  })

  test('returns "major-behind" for 0.9.0 vs latest 1.0.0', () => {
    const range = assertDefined(parseVersionRange('0.9.0'))
    const latest = assertDefined(semver.parse('1.0.0'))
    assert.strictEqual(computeStatus(range, latest, latest), 'major-behind')
  })

  test('returns "error" when latest is undefined', () => {
    const range = assertDefined(parseVersionRange('1.0.0'))
    assert.strictEqual(computeStatus(range, undefined, undefined), 'error')
  })

  test('compares against latestStable when available', () => {
    // "1.0.0" becomes ^1.0.0 which means >=1.0.0 <2.0.0
    // latestStable 1.2.0 is in that range, so it's "latest"
    const range = assertDefined(parseVersionRange('1.0.0'))
    const latestStable = assertDefined(semver.parse('1.2.0'))
    const latest = assertDefined(semver.parse('2.0.0-beta')) // prerelease is latest but not stable
    // latestStable (1.2.0) satisfies the range, so status is "latest"
    assert.strictEqual(computeStatus(range, latestStable, latest), 'latest')
  })

  test('returns "minor-behind" when latestStable does not satisfy range', () => {
    // Use exact version requirement with = to ensure it doesn't match newer versions
    const range = assertDefined(parseVersionRange('=1.0.0'))
    const latestStable = assertDefined(semver.parse('1.2.0'))
    const latest = assertDefined(semver.parse('2.0.0-beta'))
    // latestStable (1.2.0) does not satisfy =1.0.0, so compare versions
    assert.strictEqual(computeStatus(range, latestStable, latest), 'minor-behind')
  })

  // Tests for short version formats (ranges)
  test('returns "latest" for short version "0" when latestStable is 0.5.0', () => {
    // "0" means ^0 which expands to >=0.0.0 <1.0.0
    const range = assertDefined(parseVersionRange('0'))
    const latestStable = assertDefined(semver.parse('0.5.0'))
    assert.strictEqual(computeStatus(range, latestStable, latestStable), 'latest')
  })

  test('returns "latest" for short version "1" when latestStable is 1.9.0', () => {
    // "1" means ^1 which expands to >=1.0.0 <2.0.0
    const range = assertDefined(parseVersionRange('1'))
    const latestStable = assertDefined(semver.parse('1.9.0'))
    assert.strictEqual(computeStatus(range, latestStable, latestStable), 'latest')
  })

  test('returns "latest" for short version "1.0" when latestStable is 1.0.5', () => {
    // "1.0" means ^1.0 which expands to >=1.0.0 <2.0.0
    const range = assertDefined(parseVersionRange('1.0'))
    const latestStable = assertDefined(semver.parse('1.0.5'))
    assert.strictEqual(computeStatus(range, latestStable, latestStable), 'latest')
  })

  test('returns "major-behind" for short version "0" when latestStable is 1.0.0', () => {
    // "0" means >=0.0.0 <1.0.0, but latest is 1.0.0 which is outside the range
    const range = assertDefined(parseVersionRange('0'))
    const latestStable = assertDefined(semver.parse('1.0.0'))
    assert.strictEqual(computeStatus(range, latestStable, latestStable), 'major-behind')
  })

  test('returns "major-behind" for short version "1" when latestStable is 2.0.0', () => {
    // "1" means >=1.0.0 <2.0.0, but latest is 2.0.0 which is outside the range
    const range = assertDefined(parseVersionRange('1'))
    const latestStable = assertDefined(semver.parse('2.0.0'))
    assert.strictEqual(computeStatus(range, latestStable, latestStable), 'major-behind')
  })

  test('returns "latest" for "0.1" when latestStable is 0.1.5', () => {
    // "0.1" means ^0.1 which expands to >=0.1.0 <0.2.0
    const range = assertDefined(parseVersionRange('0.1'))
    const latestStable = assertDefined(semver.parse('0.1.5'))
    assert.strictEqual(computeStatus(range, latestStable, latestStable), 'latest')
  })

  test('returns "minor-behind" for "0.1" when latestStable is 0.2.0', () => {
    // "0.1" means >=0.1.0 <0.2.0, but latest is 0.2.0 which is outside the range
    const range = assertDefined(parseVersionRange('0.1'))
    const latestStable = assertDefined(semver.parse('0.2.0'))
    assert.strictEqual(computeStatus(range, latestStable, latestStable), 'minor-behind')
  })
})

describe('semver range.test() for version matching', () => {
  test('Cargo caret ranges work correctly', () => {
    const versions = ['0.0.1', '0.1.0', '1.0.0', '1.2.3', '2.0.0'].map((v) => assertDefined(semver.parse(v)))

    // Cargo default: ^version (compatible versions)
    const range1 = assertDefined(parseVersionRange('1.2.3')) // ^1.2.3
    const range2 = assertDefined(parseVersionRange('0.0.1')) // ^0.0.1 (only 0.0.1)
    const range3 = assertDefined(parseVersionRange('0.1.0')) // ^0.1.0 (0.1.x)

    const satisfies1 = versions.filter((v) => range1.test(v))
    const satisfies2 = versions.filter((v) => range2.test(v))
    const satisfies3 = versions.filter((v) => range3.test(v))

    assert.deepStrictEqual(
      satisfies1.map((v) => v.version),
      ['1.2.3'],
    )
    assert.deepStrictEqual(
      satisfies2.map((v) => v.version),
      ['0.0.1'],
    )
    assert.deepStrictEqual(
      satisfies3.map((v) => v.version),
      ['0.1.0'],
    )
  })
})
