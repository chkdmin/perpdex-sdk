import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HyperliquidClient } from '../exchanges/hyperliquid'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const ADDR = '0x36f07dee2ab548ba7e70017a0f5d389c60c891b7'

const emptyState = {
  assetPositions: [],
  marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
  crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
  crossMaintenanceMarginUsed: '0',
  withdrawable: '0',
}

const xyzState = {
  assetPositions: [
    {
      type: 'oneWay',
      position: {
        coin: 'xyz:SKHX',
        szi: '-12.0',
        leverage: { type: 'isolated', value: 3 },
        entryPx: '1730.21',
        positionValue: '20406.0',
        unrealizedPnl: '356.5255',
        returnOnEquity: '0.0515',
        liquidationPx: '2197.12',
        marginUsed: '7277.711945',
        maxTradeSzs: ['0', '0'],
        cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
      },
    },
  ],
  marginSummary: { accountValue: '7277.711945', totalNtlPos: '20406', totalRawUsd: '27683.71', totalMarginUsed: '7277.711945' },
  crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
  crossMaintenanceMarginUsed: '0',
  withdrawable: '1234.5',
}

// body.type / body.dex 기반으로 응답을 라우팅 (병렬 호출 순서 무관)
function routeFetch(opts: {
  perpDexs?: unknown
  perpDexsFail?: boolean
  orders?: Record<string, unknown[]>
}) {
  return (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    if (body.type === 'perpDexs') {
      if (opts.perpDexsFail) return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') })
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.perpDexs ?? [null, { name: 'xyz', fullName: 'XYZ' }]) })
    }
    if (body.type === 'clearinghouseState') {
      const state = body.dex === 'xyz' ? xyzState : emptyState
      return Promise.resolve({ ok: true, json: () => Promise.resolve(state) })
    }
    if (body.type === 'frontendOpenOrders') {
      const orders = opts.orders?.[body.dex ?? 'default'] ?? []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(orders) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }
}

describe('Hyperliquid getAccountBalance (multi-dex)', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('기본 dex + 빌더 dex의 잔고를 합산한다', async () => {
    mockFetch.mockImplementation(routeFetch({}))
    const client = new HyperliquidClient()
    const result = await client.getAccountBalance({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data!.totalEquity).toBeCloseTo(7277.711945, 4)
    expect(result.data!.usedMargin).toBeCloseTo(7277.711945, 4)
    expect(result.data!.unrealizedPnl).toBeCloseTo(356.5255, 4)
  })

  it('잘못된 주소는 에러', async () => {
    const client = new HyperliquidClient()
    const result = await client.getAccountBalance({ address: 'invalid' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or missing EVM address')
  })

  it('perpDexs 조회 실패 시 기본 dex만 사용(폴백)', async () => {
    mockFetch.mockImplementation(routeFetch({ perpDexsFail: true }))
    const client = new HyperliquidClient()
    const result = await client.getAccountBalance({ address: ADDR })
    // 기본 dex는 emptyState → 합계 0, 그래도 success
    expect(result.success).toBe(true)
    expect(result.data!.totalEquity).toBe(0)
  })

  it('perpDexs 결과를 5분 내 재호출하지 않는다(캐시)', async () => {
    mockFetch.mockImplementation(routeFetch({}))
    const client = new HyperliquidClient()
    await client.getAccountBalance({ address: ADDR })
    await client.getAccountBalance({ address: ADDR })
    const perpDexsCalls = mockFetch.mock.calls.filter(
      ([, init]: [string, { body: string }]) => JSON.parse(init.body).type === 'perpDexs'
    )
    expect(perpDexsCalls).toHaveLength(1)
  })

  it('availableBalance는 top-level withdrawable 필드에서 읽어온다', async () => {
    mockFetch.mockImplementation(routeFetch({}))
    const client = new HyperliquidClient()
    const result = await client.getAccountBalance({ address: ADDR })

    expect(result.success).toBe(true)
    // xyzState has withdrawable: '1234.5', emptyState has withdrawable: '0'
    // total should be 1234.5 + 0 = 1234.5
    expect(result.data!.availableBalance).toBeCloseTo(1234.5, 4)
  })
})

describe('Hyperliquid getPositions (multi-dex)', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('빌더 dex 포지션을 기본 dex 포지션과 합쳐 반환한다', async () => {
    mockFetch.mockImplementation(routeFetch({}))
    const client = new HyperliquidClient()
    const result = await client.getPositions({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(1)
    const pos = result.data![0]
    expect(pos.market).toBe('xyz:SKHX-PERP')
    expect(pos.baseAsset).toBe('xyz:SKHX')
    expect(pos.side).toBe('short')
    expect(pos.size).toBe(12)
    expect(pos.sizeUsd).toBe(20406)
    expect(pos.leverage).toBe(3)
    expect(pos.liquidationPrice).toBeCloseTo(2197.12, 2)
  })

  it('포지션이 있는 빌더 dex의 SL/TP를 매핑한다', async () => {
    mockFetch.mockImplementation(
      routeFetch({
        orders: {
          xyz: [
            {
              coin: 'xyz:SKHX',
              oid: 1,
              side: 'B',
              sz: '0.0',
              limitPx: '2335.7',
              orderType: 'Stop Market',
              reduceOnly: true,
              triggerCondition: 'Price above 2162.7',
              triggerPx: '2162.7',
              isTrigger: true,
              isPositionTpsl: true,
            },
          ],
        },
      })
    )
    const client = new HyperliquidClient()
    const result = await client.getPositions({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data![0].stopLoss).toBeCloseTo(2162.7, 2)
  })

  it('잘못된 주소는 에러', async () => {
    const client = new HyperliquidClient()
    const result = await client.getPositions({ address: 'invalid' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or missing EVM address')
  })
})
