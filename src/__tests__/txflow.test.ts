import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TxFlowClient } from '../exchanges/txflow'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const ADDR = '0x1111111111111111111111111111111111111111'

// 실제 api.txflow.com /info clearinghouseState 응답 구조 (주소·수치는 익명화)
// accountValue = totalRawUsd + Σ unrealizedPnl = 6000 - 500 + 2.976341
const clearinghouseState = {
  assetPositions: [
    {
      position: {
        coin: 'BTC-USDC',
        asset: '1',
        entryPx: '80000.0',
        leverage: { type: 'Cross', value: 10, rawUsd: null },
        liquidationPx: '88000.0',
        marginUsed: '4050.000000',
        positionValue: '40500.000000',
        returnOnEquity: '-12.345679',
        szi: '-0.5000',
        unrealizedPnl: '-500.000000',
        maxLeverage: 75,
        cumFunding: { allTime: '', sinceOpen: '9.739726', sinceChange: '9.739726' },
        marginRatio: '14.3487',
        adlQuantile: 1,
        markPx: '81000.0',
        updateTime: 1792048902794,
        cumFee: '-13.284989',
        closedPnl: '0.000000',
      },
      type: 'OneWay',
      tpsl: [
        {
          slOrderPrice: '',
          tpOrderPrice: '',
          quantity: '0',
          slOid: '309497835977',
          tpOid: '309497835978',
          slTriggerPrice: '87000.0',
          tpTriggerPrice: '74000.0',
          slOrderType: 'Market',
          tpOrderType: 'Market',
          createTime: 1792049255297,
        },
      ],
    },
    {
      position: {
        coin: 'CELR-USDC',
        asset: '70',
        entryPx: '0.002400',
        leverage: { type: 'Cross', value: 2, rawUsd: null },
        liquidationPx: null,
        marginUsed: '14.040170',
        positionValue: '28.080341',
        returnOnEquity: '21.198753',
        szi: '10460',
        unrealizedPnl: '2.976341',
        maxLeverage: 20,
        cumFunding: { allTime: '', sinceOpen: '2.806898', sinceChange: '2.806898' },
        marginRatio: '820.6548',
        adlQuantile: 5,
        markPx: '0.002684',
        updateTime: 1775917888750,
        cumFee: '0.000000',
        closedPnl: '0.000000',
      },
      type: 'OneWay',
    },
  ],
  crossMarginSummary: {
    accountValue: '5502.976341',
    totalMarginUsed: '4064.040170',
    totalNtlPos: '40528.080341',
    totalRawUsd: '6000.000000',
  },
  marginSummary: {
    accountValue: '5502.976341',
    totalMarginUsed: '4064.040170',
    totalNtlPos: '40528.080341',
    totalRawUsd: '6000.000000',
  },
  crossMaintenanceMarginUsed: '178.638689',
  crossMarginRatio: '14.3487',
  withdrawable: '1438.936171',
  totalRawUsdPlusWithdrawHold: '6000.000000',
  accountValuePlusWithdrawHold: '5502.976341',
  vaultEquity: '0.000000',
  time: 1792225818589,
}

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
}

function errorResponse(status: number, text: string) {
  return Promise.resolve({ ok: false, status, text: () => Promise.resolve(text) })
}

describe('TxFlow getAccountBalance', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('clearinghouseState의 marginSummary/withdrawable로 잔고를 계산한다', async () => {
    mockFetch.mockImplementation(() => jsonResponse(clearinghouseState))
    const client = new TxFlowClient()
    const result = await client.getAccountBalance({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      exchange: 'txflow',
      totalEquity: 5502.976341,
      availableBalance: 1438.936171,
      usedMargin: 4064.04017,
      unrealizedPnl: expect.closeTo(-497.023659, 6),
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.txflow.com/info')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ type: 'clearinghouseState', user: ADDR })
  })

  it('잘못된 주소는 요청 없이 에러', async () => {
    const client = new TxFlowClient()
    const result = await client.getAccountBalance({ address: 'invalid' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or missing EVM address')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('API 에러 응답이면 실패를 반환한다', async () => {
    mockFetch.mockImplementation(() => errorResponse(403, '{"message":"This action is not allowed."}'))
    const client = new TxFlowClient()
    const result = await client.getAccountBalance({ address: ADDR })

    expect(result.success).toBe(false)
    expect(result.error).toContain('403')
  })
})

describe('TxFlow getPositions', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('숏 포지션을 변환한다 (coin 접미사 제거, ROE는 이미 퍼센트, 포지션 tpsl 사용)', async () => {
    mockFetch.mockImplementation(() => jsonResponse(clearinghouseState))
    const client = new TxFlowClient()
    const result = await client.getPositions({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data![0]).toEqual({
      id: 'txflow_BTC-PERP_short',
      exchange: 'txflow',
      market: 'BTC-PERP',
      baseAsset: 'BTC',
      side: 'short',
      size: 0.5,
      sizeUsd: 40500,
      entryPrice: 80000,
      markPrice: 81000,
      unrealizedPnl: -500,
      unrealizedPnlPercent: -12.345679,
      leverage: 10,
      liquidationPrice: 88000,
      stopLoss: 87000,
      takeProfit: 74000,
      margin: 4050,
      marginRatio: null,
      createdAt: null,
      updatedAt: expect.any(Date),
    })
  })

  it('tpsl이 없는 롱 포지션은 SL/TP·청산가가 null이고 markPx를 그대로 쓴다', async () => {
    mockFetch.mockImplementation(() => jsonResponse(clearinghouseState))
    const client = new TxFlowClient()
    const result = await client.getPositions({ address: ADDR })

    const celr = result.data![1]
    expect(celr.baseAsset).toBe('CELR')
    expect(celr.side).toBe('long')
    expect(celr.size).toBe(10460)
    expect(celr.markPrice).toBe(0.002684)
    expect(celr.unrealizedPnlPercent).toBe(21.198753)
    expect(celr.liquidationPrice).toBeNull()
    expect(celr.stopLoss).toBeNull()
    expect(celr.takeProfit).toBeNull()
  })

  it('비어 있는 트리거가는 null로 처리한다 (TP만 설정된 경우)', async () => {
    const tpOnly = structuredClone(clearinghouseState)
    tpOnly.assetPositions[0].tpsl![0].slTriggerPrice = ''
    mockFetch.mockImplementation(() => jsonResponse(tpOnly))
    const client = new TxFlowClient()
    const result = await client.getPositions({ address: ADDR })

    expect(result.data![0].stopLoss).toBeNull()
    expect(result.data![0].takeProfit).toBe(74000)
  })

  it('조회 실패는 빈 성공이 아니라 에러로 반환한다', async () => {
    mockFetch.mockImplementation(() => errorResponse(500, 'boom'))
    const client = new TxFlowClient()
    const result = await client.getPositions({ address: ADDR })

    expect(result.success).toBe(false)
    expect(result.data).toBeNull()
  })

  it('잘못된 주소는 요청 없이 에러', async () => {
    const client = new TxFlowClient()
    const result = await client.getPositions({ address: '0x123' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or missing EVM address')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('TxFlow getSpotBalances', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('spotClearinghouseState의 0이 아닌 잔고만 반환한다', async () => {
    mockFetch.mockImplementation(() =>
      jsonResponse({
        balances: [
          { coin: 'USDC', displayName: 'USDC', hold: '2.500000', total: '12.500000', entryNtl: '0.000000', token: 1 },
          { coin: 'BTC', displayName: 'BTC', hold: '0.0000', total: '0.0000', entryNtl: '0.000000', token: 2 },
        ],
      })
    )
    const client = new TxFlowClient()
    const result = await client.getSpotBalances({ address: ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([{ symbol: 'USDC', balance: '12.500000', lockedBalance: '2.500000' }])
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ type: 'spotClearinghouseState', user: ADDR })
  })

  it('조회 실패는 에러로 반환한다', async () => {
    mockFetch.mockImplementation(() => errorResponse(500, 'boom'))
    const client = new TxFlowClient()
    const result = await client.getSpotBalances({ address: ADDR })

    expect(result.success).toBe(false)
  })
})

describe('TxFlow clearinghouseState 요청 공유', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('잔고와 포지션을 동시에 조회하면 clearinghouseState 요청은 한 번만 보낸다', async () => {
    mockFetch.mockImplementation(() => jsonResponse(clearinghouseState))
    const client = new TxFlowClient()

    const [balance, positions] = await Promise.all([
      client.getAccountBalance({ address: ADDR }),
      client.getPositions({ address: ADDR }),
    ])

    expect(balance.data!.totalEquity).toBe(5502.976341)
    expect(positions.data).toHaveLength(2)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('이전 요청이 끝난 뒤의 조회는 새로 요청한다 (결과를 캐시하지 않음)', async () => {
    mockFetch.mockImplementation(() => jsonResponse(clearinghouseState))
    const client = new TxFlowClient()

    await client.getAccountBalance({ address: ADDR })
    await client.getPositions({ address: ADDR })

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('실패한 요청도 공유하고, 이후 조회는 다시 시도한다', async () => {
    mockFetch.mockImplementationOnce(() => errorResponse(500, 'boom'))
    const client = new TxFlowClient()

    const [balance, positions] = await Promise.all([
      client.getAccountBalance({ address: ADDR }),
      client.getPositions({ address: ADDR }),
    ])
    expect(balance.success).toBe(false)
    expect(positions.success).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockImplementation(() => jsonResponse(clearinghouseState))
    const retried = await client.getAccountBalance({ address: ADDR })
    expect(retried.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
