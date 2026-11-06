import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

test('shared kernel does not depend on a feature or platform adapter', async () => {
  const glob = new Bun.Glob('**/*.ts')
  for await (const file of glob.scan('src/shared-kernel')) {
    const source = await Bun.file(`src/shared-kernel/${file}`).text()
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1]!,
    )
    for (const dependency of imports) {
      expect(dependency).not.toContain('/features/')
      expect(dependency).not.toContain('/infrastructure/')
      expect(dependency).not.toContain('/platform/')
    }
  }
})

test('le domaine et l’application ignorent OpenTelemetry', async () => {
  const glob = new Bun.Glob('**/*.ts')
  for await (const file of glob.scan('src')) {
    const isApplicationOrDomain = /\/(application|domain)\//.test(file)
    if (!isApplicationOrDomain && !file.startsWith('shared-kernel/')) {
      continue
    }
    const source = await Bun.file(`src/${file}`).text()
    expect(source).not.toContain('@opentelemetry/')
    expect(source).not.toContain('/observability/')
  }
})

test('technical modules live under platform, not a top-level adapter layer', () => {
  expect(existsSync('src/infrastructure')).toBe(false)
  for (const module of [
    'di',
    'http',
    'messaging',
    'observability',
    'rate-limit',
  ]) {
    expect(existsSync(`src/platform/${module}`)).toBe(true)
  }
})

test('rate-limit domain and application do not import adapters or business features', async () => {
  const root = resolve('src/platform/rate-limit')
  for (const layer of ['domain', 'application']) {
    const allowed = [resolve(root, 'domain'), resolve('src/shared-kernel')]
    if (layer === 'application') {
      allowed.push(resolve(root, 'application'))
    }
    for await (const file of new Bun.Glob('**/*.ts').scan(`${root}/${layer}`)) {
      const filename = resolve(root, layer, file)
      const source = await Bun.file(filename).text()
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const dependency = match[1]!
        const target = dependency.startsWith('#/')
          ? resolve('src', dependency.slice(2))
          : resolve(filename, '..', dependency)
        expect(
          allowed.some((directory) => target.startsWith(directory + sep)),
        ).toBe(true)
      }
    }
  }
})

// Keep the lesson's dependency rule executable as files move and features grow.
test('contexts share only published contracts, never domain models or repositories', async () => {
  const glob = new Bun.Glob('**/*.ts')
  for await (const file of glob.scan('src/features')) {
    const source = await Bun.file(`src/features/${file}`).text()
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1]!,
    )
    for (const dependency of imports) {
      if (file.startsWith('events/')) {
        expect(dependency).not.toContain('/features/notifications/')
      }
      if (
        file.startsWith('notifications/') &&
        dependency.includes('/features/events/')
      ) {
        expect(file).toBe('notifications/infrastructure/events-subscriber.ts')
        expect(dependency).toBe('#/features/events/contracts/events.ts')
      }
      if (file.startsWith('events/contracts/')) {
        expect(dependency).not.toContain('/domain/')
      }
    }
  }
})
