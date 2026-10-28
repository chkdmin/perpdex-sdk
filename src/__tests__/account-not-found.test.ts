import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LighterClient } from '../exchanges/lighter'
import { PacificaClient } from '../exchanges/pacifica'
import { ExtendedClient } from '../exchanges/extended'
import { ArcusClient } from '../exchanges/arcus'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())
afterEach(() => vi.restoreAllMocks())

function response(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

const EVM_ADDR = '0xc40f927792837d9f442d8b67c99721ce9a22a5d3'
const SOL_ADDR = 'Gykw7X8rcWtva7QH2CKvPXyPKbbJCW2QymYBK6pCLnYz'

// 계정이 없는 주소는 장애가 아니라 "잔고 0"이다. 에러로 반환하면 소비자가 조회 실패로 취급한다.
describe('Lighter: 계정이 없는 주소', () => {
  // 실제 응답: HTTP 400 {"code":21100,"message":"account not found"}
  const notFound = () => response(400, { code: 21100, message: 'account not found' })

  it('getAccountBalance는 잔고 0으로 성공한다', async () => {
    mockFetch.mockImplementation(notFound)
    const result = await new LighterClient().getAccountBalance({ address: EVM_ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ totalEquity: 0, availableBalance: 0, usedMargin: 0, unrealizedPnl: 0 })
  })

  it('getPositions는 빈 배열로 성공한다', async () => {
    mockFetch.mockImplementation(notFound)
    const result = await new LighterClient().getPositions({ address: EVM_ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
  })

  it('다른 400 에러는 그대로 실패한다', async () => {
    mockFetch.mockImplementation(() => response(400, { code: 20001, message: 'invalid param' }))
    const result = await new LighterClient().getAccountBalance({ address: EVM_ADDR })

    expect(result.success).toBe(false)
  })
})

describe('Pacifica: 계정이 없는 주소', () => {
  it('getAccountBalance는 404 Account not found를 잔고 0으로 처리한다', async () => {
    // 실제 응답: HTTP 404 {"success":false,"data":null,"error":"Account not found","code":404}
    mockFetch.mockImplementation(() =>
      response(404, { success: false, data: null, error: 'Account not found', code: 404, error_id: 'unspecified' })
    )
    const result = await new PacificaClient().getAccountBalance({ address: SOL_ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ totalEquity: 0, availableBalance: 0, usedMargin: 0, unrealizedPnl: 0 })
  })

  it('다른 404는 그대로 실패한다', async () => {
    mockFetch.mockImplementation(() => response(404, { success: false, data: null, error: 'Not Found', code: 404 }))
    const result = await new PacificaClient().getAccountBalance({ address: SOL_ADDR })

    expect(result.success).toBe(false)
  })

  it('서버 에러는 그대로 실패한다', async () => {
    mockFetch.mockImplementation(() => response(500, { success: false, error: 'Internal error' }))
    const result = await new PacificaClient().getAccountBalance({ address: SOL_ADDR })

    expect(result.success).toBe(false)
  })
})

describe('Extended: 잔고가 0인 계정', () => {
  // API 문서: GET /api/v1/user/balance "Returns a 404 error if the user's balance is 0."
  it('getAccountBalance는 404를 잔고 0으로 처리한다', async () => {
    mockFetch.mockImplementation(() => response(404, { status: 'ERROR', error: { code: 'NOT_FOUND', message: 'Balance not found' } }))
    const result = await new ExtendedClient({ apiKey: 'key', apiSecret: '' }).getAccountBalance()

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ totalEquity: 0, availableBalance: 0, usedMargin: 0, unrealizedPnl: 0 })
  })

  it('인증 오류는 그대로 실패한다', async () => {
    mockFetch.mockImplementation(() => response(401, { status: 'ERROR', error: { code: 'UNAUTHORIZED', message: 'Invalid api key' } }))
    const result = await new ExtendedClient({ apiKey: 'bad', apiSecret: '' }).getAccountBalance()

    expect(result.success).toBe(false)
  })

  it('서버 에러는 그대로 실패한다', async () => {
    mockFetch.mockImplementation(() => response(500, { status: 'ERROR' }))
    const result = await new ExtendedClient({ apiKey: 'key', apiSecret: '' }).getAccountBalance()

    expect(result.success).toBe(false)
  })
})

describe('Arcus: 활동 이력이 없는 계정', () => {
  // 실제 응답: HTTP 404 {"error":"this account has no activity yet"}
  const noActivity = () => response(404, { error: 'this account has no activity yet' })

  it('getAccountBalance는 잔고 0으로 성공한다', async () => {
    mockFetch.mockImplementation(noActivity)
    const result = await new ArcusClient().getAccountBalance({ address: EVM_ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ totalEquity: 0, availableBalance: 0, usedMargin: 0, unrealizedPnl: 0 })
  })

  it('getPositions는 빈 배열로 성공하고 openOrders는 요청하지 않는다', async () => {
    mockFetch.mockImplementation(noActivity)
    const result = await new ArcusClient().getPositions({ address: EVM_ADDR })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('다른 404는 그대로 실패한다', async () => {
    mockFetch.mockImplementation(() => response(404, { error: 'Not found' }))
    const result = await new ArcusClient().getAccountBalance({ address: EVM_ADDR })

    expect(result.success).toBe(false)
  })
})
