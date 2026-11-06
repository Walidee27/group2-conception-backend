import { SQL } from 'bun'
import { GenericContainer, Wait } from 'testcontainers'
import type { IdentityRepository } from '#/features/identity/application/ports.ts'
import { InMemoryIdentityRepository } from '#/features/identity/infrastructure/in-memory-identity-repository.ts'
import { PostgresIdentityRepository } from '#/features/identity/infrastructure/postgres-identity-repository.ts'

export const alice = '01900000-0000-7000-8000-000000000001'
export const bob = '01900000-0000-7000-8000-000000000002'
export const unknownUser = '01900000-0000-7000-8000-000000000099'

export interface IdentityRepositoryFixture {
  repository: IdentityRepository
  peer: IdentityRepository
  reset(): Promise<void>
  close(): Promise<void>
}

async function inMemory(): Promise<IdentityRepositoryFixture> {
  let repository = new InMemoryIdentityRepository(new Set([alice, bob]))
  return {
    get repository() {
      return repository
    },
    get peer() {
      return repository
    },
    async reset() {
      repository = new InMemoryIdentityRepository(new Set([alice, bob]))
    },
    async close() {},
  }
}

async function postgres(): Promise<IdentityRepositoryFixture> {
  const container = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({
      POSTGRES_DB: 'identity',
      POSTGRES_USER: 'identity',
      POSTGRES_PASSWORD: 'identity',
    })
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ['CMD-SHELL', 'pg_isready -U identity -d identity'],
      interval: 1000,
      timeout: 3000,
      retries: 30,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start()
  const url = `postgres://identity:identity@${container.getHost()}:${container.getMappedPort(5432)}/identity`
  const sql = new SQL(url, { max: 1 })
  const peer = new SQL(url)
  async function close() {
    try {
      await Promise.all([sql.close(), peer.close()])
    } finally {
      await container.stop()
    }
  }
  try {
    await sql.unsafe(
      await Bun.file(new URL('../../sql/_schema.sql', import.meta.url)).text(),
    )
    await sql`INSERT INTO identity.users (id, name, email) VALUES
      (${alice}, 'Alice', 'alice@identity.test'), (${bob}, 'Bob', 'bob@identity.test')
      ON CONFLICT DO NOTHING`
    return {
      repository: new PostgresIdentityRepository(sql),
      peer: new PostgresIdentityRepository(peer),
      async reset() {
        await sql`TRUNCATE identity.sessions`
      },
      close,
    }
  } catch (cause) {
    await close()
    throw cause
  }
}

export const identityRepositoryFactories = [
  { name: 'in-memory', create: inMemory },
  { name: 'PostgreSQL', create: postgres },
]
