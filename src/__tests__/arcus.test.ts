import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ArcusClient } from '../exchanges/arcus'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const ADDR = '0x1111111111111111111111111111111111111111'

// 실제 api.arcus.xyz GET /v1/account 응답 구조 (주소·수치는 익명화)
// equity = netQuoteBalance + Σ (size × oracle) = -26809.75 + 31960 - 2150
const account = {
  accountIndex: 0,
  address: ADDR,
  netQuoteBalance: '-26809.75',
  equity: '3000.25',
  freeCollateral: '50.75',
  netDeposits: '3000',
  pendingDeposits: '0',
  pendingWithdrawals: '0',
  positions: {
    '1': {
      address: ADDR,
      accountIndex: 0,
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'LONG',
      size: '0.4',
      averageEntryPrice: '80000',
      leverage: '10',
      marginMode: 'CROSS',
      borrowedCapital: '-32000',
      marginUsed: '3196',
      positionValueNotional: '31960',
      unrealizedPnl: '-40',
      markPx: '79900',
    },
    '28': {
      address: ADDR,
      accountIndex: 0,
      marketId: 28,
      marketDisplayName: 'NVDA-USD',
      side: 'SHORT',
      size: '-10',
      averageEntryPrice: '220',
      cumulativeFunding: { allTime: '1.5', sinceOpen: '1.5', sinceChange: '0' },
      leverage: '20',
      marginMode: 'CROSS',
      borrowedCapital: '2200',
      marginUsed: '107.5',
      positionValueNotional: '-2150',
      unrealizedPnl: '50',
      markPx: '215',
    },
  },
  sequenceNumber: 12,
  netDepositsByAsset: [{ spotAssetId: 0, spotAssetDisplayName: 'USDG', netAmount: '3000' }],
}

// 실제 GET /v1/openOrders 응답 구조. 포지션 TP/SL은 triggerPrice + tpslType + isPositionTPSL
const openOrders = {
  orders: [
    {
      orderId: 'aaaaaaaaaaaaaaa1',
      address: ADDR,
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      status: 'UNTRIGGERED',
      price: '70300',
      originalSize: '0',
      filledSize: '0',
      remainingSize: '0',
      timeInForce: 'IOC',
      triggerPrice: '74000',
      tpslType: 'STOP_LOSS',
      isPositionTPSL: true,
      reduceOnly: true,
    },
    {
      orderId: 'aaaaaaaaaaaaaaa2',
      address: ADDR,
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      status: 'UNTRIGGERED',
      price: '82500',
      originalSize: '0',
      filledSize: '0',
      remainingSize: '0',
      timeInForce: 'IOC',
      triggerPrice: '88000',
      tpslType: 'TAKE_PROFIT',
      isPositionTPSL: true,
      reduceOnly: true,
    },
    {
      // 수량을 지정한 부분 TP/SL — 포지션 전체 TP/SL이 아니므로 무시
      orderId: 'aaaaaaaaaaaaaaa3',
      address: ADDR,
      marketId: 28,
      marketDisplayName: 'NVDA-USD',
      side: 'BUY',
      type: 'MARKET',
      status: 'UNTRIGGERED',
      price: '235',
      originalSize: '5',
      filledSize: '0',
      remainingSize: '5',
      timeInForce: 'IOC',
      triggerPrice: '230',
      tpslType: 'STOP_LOSS',
      isPositionTPSL: false,
      reduceOnly: true,
    },
    {
      orderId: 'aaaaaaaaaaaaaaa4',
      address: ADDR,
      marketId: 28,
      marketDisplayName: 'NVDA-USD',
      side: 'BUY',
      type: 'LIMIT',
      status: 'OPEN',
      price: '200',
      originalSize: '1',
      filledSize: '0',
      remainingSize: '1',
      timeInForce: 'GTC',
    },
  ],
  total: 4,
}

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

function errorResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

function routeByPath(routes: Record<string, () => Promise<unknown>>) {
  return (url: string) => {
    const path = new URL(url).pathname
    const handler = routes[path]
    if (!handler) throw new Error(`unexpected request: ${url}`)
    return handler()
  }
}

const defaultRoutes = {
  '/v1/account': () => jsonResponse(account),
  '/v1/openOrders': () => jsonResponse(openOrders),
}

describe('Arcus getAccountBalance', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('account의 equity/freeCollateral과 포지션 합계로 잔고를 계산한다', async () => {
    mockFetch.mockImplementation(routeByPath(defaultRoutes))
    const result = await new ArcusClient().getAccountBalance({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      exchange: 'arcus',
      totalEquity: 3000.25,
      availableBalance: 50.75,
      usedMargin: 3303.5,
      unrealizedPnl: 10,
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toBe(`https://api.arcus.xyz/v1/account?address=${ADDR}`)
  })

  it('spot 담보 때문에 freeCollateral이 음수면 사용 가능 잔고는 0이다', async () => {
    mockFetch.mockImplementation(routeByPath({ '/v1/account': () => jsonResponse({ ...account, freeCollateral: '-12.5' }) }))
    const result = await new ArcusClient().getAccountBalance({ address: ADDR })

    expect(result.data!.availableBalance).toBe(0)
  })

  it('잘못된 주소는 요청 없이 에러', async () => {
    const result = await new ArcusClient().getAccountBalance({ address: 'invalid' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or missing EVM address')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // 초대 코드로 perp 접근 권한을 받지 않은 주소. ToS 차단 지갑도 출금은 가능하므로
  // 자금이 남은 계정일 수 있어 잔고 0으로 단정하지 않는다
  it('접근 허용 목록에 없는 주소(403)는 실패로 반환한다', async () => {
    mockFetch.mockImplementation(() => errorResponse(403, { error: 'address not on access whitelist' }))
    const result = await new ArcusClient().getAccountBalance({ address: ADDR })

    expect(result.success).toBe(false)
    expect(result.error).toContain('403')
    expect(result.error).toContain('address not on access whitelist')
  })
})

describe('Arcus getPositions', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('롱 포지션을 변환하고 포지션 TP/SL을 openOrders에서 붙인다', async () => {
    mockFetch.mockImplementation(routeByPath(defaultRoutes))
    const result = await new ArcusClient().getPositions({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data![0]).toEqual({
      id: 'arcus_BTC-PERP_long',
      exchange: 'arcus',
      market: 'BTC-PERP',
      baseAsset: 'BTC',
      side: 'long',
      size: 0.4,
      sizeUsd: 31960,
      entryPrice: 80000,
      markPrice: 79900,
      unrealizedPnl: -40,
      // 응답에 ROE가 없어 사용 증거금 대비 미실현손익으로 계산
      unrealizedPnlPercent: expect.closeTo((-40 / 3196) * 100, 10),
      leverage: 10,
      liquidationPrice: null,
      stopLoss: 74000,
      takeProfit: 88000,
      margin: 3196,
      marginRatio: null,
      createdAt: null,
      updatedAt: expect.any(Date),
    })
    // 최신순 1000개 제한보다 status 필터가 먼저 적용되므로, 주문이 많아도 TP/SL이 잘리지 않는다
    expect(mockFetch.mock.calls[1][0]).toBe(
      `https://api.arcus.xyz/v1/openOrders?address=${ADDR}&status=UNTRIGGERED`
    )
  })

  it('주식 perp 숏 포지션은 -USD 접미사를 떼고, 부분 TP/SL과 일반 주문은 무시한다', async () => {
    mockFetch.mockImplementation(routeByPath(defaultRoutes))
    const result = await new ArcusClient().getPositions({ address: ADDR })

    const nvda = result.data![1]
    expect(nvda.market).toBe('NVDA-PERP')
    expect(nvda.baseAsset).toBe('NVDA')
    expect(nvda.side).toBe('short')
    expect(nvda.size).toBe(10)
    expect(nvda.sizeUsd).toBe(2150)
    expect(nvda.leverage).toBe(20)
    expect(nvda.unrealizedPnlPercent).toBeCloseTo((50 / 107.5) * 100, 10)
    expect(nvda.stopLoss).toBeNull()
    expect(nvda.takeProfit).toBeNull()
  })

  it('openOrders 조회가 실패해도 포지션은 TP/SL 없이 반환한다', async () => {
    mockFetch.mockImplementation(
      routeByPath({ ...defaultRoutes, '/v1/openOrders': () => errorResponse(500, { error: 'boom' }) })
    )
    const result = await new ArcusClient().getPositions({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2)
    expect(result.data![0].stopLoss).toBeNull()
    expect(result.data![0].takeProfit).toBeNull()
  })

  it('포지션이 없으면 openOrders를 요청하지 않는다', async () => {
    mockFetch.mockImplementation(routeByPath({ '/v1/account': () => jsonResponse({ ...account, positions: {} }) }))
    const result = await new ArcusClient().getPositions({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('조회 실패는 빈 성공이 아니라 에러로 반환한다', async () => {
    mockFetch.mockImplementation(() => errorResponse(500, { error: 'boom' }))
    const result = await new ArcusClient().getPositions({ address: ADDR })

    expect(result.success).toBe(false)
    expect(result.data).toBeNull()
  })

  it('잘못된 주소는 요청 없이 에러', async () => {
    const result = await new ArcusClient().getPositions({ address: '0x123' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or missing EVM address')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('Arcus account 요청 공유', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('잔고와 포지션을 동시에 조회하면 account 요청은 한 번만 보낸다', async () => {
    mockFetch.mockImplementation(routeByPath(defaultRoutes))
    const client = new ArcusClient()

    const [balance, positions] = await Promise.all([
      client.getAccountBalance({ address: ADDR }),
      client.getPositions({ address: ADDR }),
    ])

    expect(balance.data!.totalEquity).toBe(3000.25)
    expect(positions.data).toHaveLength(2)
    const accountCalls = mockFetch.mock.calls.filter(([url]) => new URL(url).pathname === '/v1/account')
    expect(accountCalls).toHaveLength(1)
  })

  it('이전 요청이 끝난 뒤의 조회는 새로 요청한다 (결과를 캐시하지 않음)', async () => {
    mockFetch.mockImplementation(routeByPath(defaultRoutes))
    const client = new ArcusClient()

    await client.getAccountBalance({ address: ADDR })
    await client.getAccountBalance({ address: ADDR })

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

// 형식이 깨진 200 응답을 "잔고 0 / 포지션 없음"으로 성공 처리하면 소비자가 기존 자산을 지운다
describe('Arcus 비정상 응답 검증', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('equity가 비어 있으면 잔고 조회를 실패로 반환한다', async () => {
    mockFetch.mockImplementation(routeByPath({ '/v1/account': () => jsonResponse({ ...account, equity: '' }) }))
    const result = await new ArcusClient().getAccountBalance({ address: ADDR })

    expect(result.success).toBe(false)
  })

  it('positions가 없는 200 응답은 잔고·포지션 조회를 실패로 반환한다', async () => {
    mockFetch.mockImplementation(() => jsonResponse({ error: 'unexpected' }))
    const client = new ArcusClient()

    const [balance, positions] = await Promise.all([
      client.getAccountBalance({ address: ADDR }),
      client.getPositions({ address: ADDR }),
    ])
    expect(balance.success).toBe(false)
    expect(positions.success).toBe(false)
  })

  it('포지션의 markPx가 비어 있으면 포지션 조회를 실패로 반환한다', async () => {
    const broken = structuredClone(account)
    broken.positions['1'].markPx = ''
    mockFetch.mockImplementation(routeByPath({ ...defaultRoutes, '/v1/account': () => jsonResponse(broken) }))

    const result = await new ArcusClient().getPositions({ address: ADDR })
    expect(result.success).toBe(false)
  })
})

describe('Arcus 요청 타임아웃', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('응답 없이 멈춘 요청은 abort signal로 끊긴다', async () => {
    // signal이 abort되면 reject하는 fetch — signal을 넘기지 않으면 영원히 대기한다
    mockFetch.mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    )
    const pending = new ArcusClient().getAccountBalance({ address: ADDR })
    const signal: AbortSignal = mockFetch.mock.calls[0][1].signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    // 타임아웃 시간을 기다리지 않고 abort 이벤트로 타임아웃을 재현한다
    signal.dispatchEvent(new Event('abort'))
    const result = await pending
    expect(result.success).toBe(false)
  })
})
