import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LighterClient } from '../exchanges/lighter'
import { HyperliquidClient } from '../exchanges/hyperliquid'
import { BackpackClient } from '../exchanges/backpack'
import { AsterClient } from '../exchanges/aster'
import { GrvtClient } from '../exchanges/grvt'
import { PacificaClient } from '../exchanges/pacifica'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Lighter getSpotBalances', () => {
  it('parses spot assets from account endpoint', async () => {
    const client = new LighterClient()

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          code: 200,
          total: 1,
          accounts: [
            {
              code: 200,
              account_type: 0,
              index: 1,
              account_index: 1,
              l1_address: '0x1234567890abcdef1234567890abcdef12345678',
              available_balance: '1000',
              collateral: '1200',
              total_asset_value: '1500',
              positions: [],
              assets: [
                { symbol: 'ETH', balance: '1.5', locked_balance: '0.2' },
                { symbol: 'BTC', balance: '0.05', locked_balance: '0' },
                { symbol: 'USDC', balance: '500', locked_balance: '0' },
              ],
            },
          ],
        }),
    })

    const result = await client.getSpotBalances({
      address: '0x1234567890abcdef1234567890abcdef12345678',
    })

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2) // USDC excluded
    expect(result.data![0]).toEqual({
      symbol: 'ETH',
      balance: '1.5',
      lockedBalance: '0.2',
    })
    expect(result.data![1]).toEqual({
      symbol: 'BTC',
      balance: '0.05',
      lockedBalance: '0',
    })
  })

  it('returns empty array when no assets', async () => {
    const client = new LighterClient()

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          code: 200,
          total: 1,
          accounts: [
            {
              code: 200,
              account_type: 0,
              index: 1,
              account_index: 1,
              l1_address: '0x1234567890abcdef1234567890abcdef12345678',
              available_balance: '0',
              collateral: '0',
              total_asset_value: '0',
              positions: [],
            },
          ],
        }),
    })

    const result = await client.getSpotBalances({
      address: '0x1234567890abcdef1234567890abcdef12345678',
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
  })
})

describe('Hyperliquid getSpotBalances', () => {
  it('parses spot balances from spotClearinghouseState', async () => {
    const client = new HyperliquidClient()

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          balances: [
            { coin: 'ETH', total: '2.5', hold: '0.1', entryNtl: '5000', token: 1 },
            { coin: 'PURR', total: '100000', hold: '0', entryNtl: '200', token: 2 },
          ],
        }),
    })

    const result = await client.getSpotBalances({
      address: '0x1234567890abcdef1234567890abcdef12345678',
    })

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2)
    expect(result.data![0]).toEqual({
      symbol: 'ETH',
      balance: '2.5',
      lockedBalance: '0.1',
    })
  })

  it('returns error for invalid address', async () => {
    const client = new HyperliquidClient()
    const result = await client.getSpotBalances({ address: 'invalid' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or missing EVM address')
  })
})

describe('Backpack getSpotBalances', () => {
  it('parses capital balances', async () => {
    const client = new BackpackClient({
      apiKey: 'test-key',
      apiSecret: Buffer.from(new Uint8Array(32)).toString('base64'),
    })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          SOL: { available: '10.5', locked: '1.0', staked: '0.5' },
          USDC: { available: '500', locked: '0', staked: '0' },
          BTC: { available: '0', locked: '0', staked: '0' },
        }),
    })

    const result = await client.getSpotBalances()

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2) // BTC excluded (zero balance)
    expect(result.data![0]).toEqual({
      symbol: 'SOL',
      balance: '12',
      lockedBalance: '1.0',
    })
    expect(result.data![1]).toEqual({
      symbol: 'USDC',
      balance: '500',
      lockedBalance: '0',
    })
  })
})

describe('Aster getSpotBalances', () => {
  it('parses spot account assets', async () => {
    const client = new AsterClient({ apiKey: 'test', apiSecret: 'secret' })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          assets: [
            { a: 'BTC', f: '0.001', l: '0.0' },
            { a: 'ETH', f: '0.5', l: '0.1' },
            { a: 'USDT', f: '0', l: '0' },
          ],
        }),
    })

    const result = await client.getSpotBalances()

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2) // USDT excluded (zero)
    expect(result.data![0]).toEqual({
      symbol: 'BTC',
      balance: '0.001',
      lockedBalance: '0.0',
    })
  })
})

describe('GRVT getSpotBalances', () => {
  it('parses funding account balances', async () => {
    const client = new GrvtClient({
      apiKey: 'test',
      apiSecret: 'secret',
      tradingAccountId: 'account-1',
    })

    // First call: authenticate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{"status":"success"}'),
      headers: {
        getSetCookie: () => ['gravity=session-token; path=/'],
        get: (name: string) => (name === 'x-grvt-account-id' ? 'acc-123' : null),
      },
    })

    // Second call: get_funding_account_summary
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            balances: [
              { currency: 'ETH', balance: '1.0', locked_balance: '0' },
              { currency: 'USDC', balance: '2000', locked_balance: '100' },
            ],
          },
        }),
    })

    const result = await client.getSpotBalances()

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2)
    expect(result.data![0]).toEqual({
      symbol: 'ETH',
      balance: '1.0',
      lockedBalance: '0',
    })
  })
})

describe('ExchangeClient without getSpotBalances', () => {
  it('clients without spot support have undefined getSpotBalances', () => {
    const pacifica = new PacificaClient()
    expect(pacifica.getSpotBalances).toBeUndefined()
  })
})
