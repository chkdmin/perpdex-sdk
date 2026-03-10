import { describe, it, expect } from 'vitest'
import { createClient } from '../client'

describe('createClient', () => {
  it('throws on unknown exchange id', () => {
    expect(() => createClient('unknown' as any)).toThrow()
  })

  it('creates Pacifica client without config', () => {
    const client = createClient('pacifica')
    expect(client.exchangeId).toBe('pacifica')
  })

  it('creates Hyperliquid client without config', () => {
    const client = createClient('hyperliquid')
    expect(client.exchangeId).toBe('hyperliquid')
  })

  it('creates StandX client with JWT config', () => {
    const client = createClient('standx', { jwtToken: 'test-token' })
    expect(client.exchangeId).toBe('standx')
  })

  it('creates Extended client with API key config', () => {
    const client = createClient('extended', { apiKey: 'key', apiSecret: 'secret' })
    expect(client.exchangeId).toBe('extended')
  })
})
