import type { ExchangeId, Position, AccountBalance, SpotBalance, ExchangeResponse, AddressQuery } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId, isValidEvmAddress } from '../utils'

// 공식 API 문서 미공개 — app.txflow.com이 사용하는 Hyperliquid 호환 /info 엔드포인트
const TXFLOW_API_BASE = 'https://api.txflow.com'
// 응답 없이 멈춘 요청이 소비자의 순차 sync 루프를 막지 않도록 본문 수신까지 포함해 끊는다
const TXFLOW_REQUEST_TIMEOUT_MS = 15_000

interface TxFlowAssetPosition {
  position: {
    coin: string
    szi: string
    leverage: { type: string; value: number }
    entryPx: string
    markPx: string
    positionValue: string
    unrealizedPnl: string
    returnOnEquity: string
    liquidationPx: string | null
    marginUsed: string
  }
  // 포지션에 걸린 TP/SL. 미설정 트리거가는 빈 문자열
  tpsl?: { slTriggerPrice: string; tpTriggerPrice: string }[]
}

interface TxFlowClearinghouseState {
  assetPositions: TxFlowAssetPosition[]
  marginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
  }
  withdrawable: string
}

interface TxFlowSpotClearinghouseState {
  balances: { coin: string; total: string; hold: string }[]
}

// 형식이 깨진 200 응답을 0으로 바꿔 성공 처리하면 소비자가 기존 자산을 지우므로 실패로 던진다
function requireNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? parseFloat(String(value)) : NaN
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unexpected TxFlow response: invalid ${field}`)
  }
  return parsed
}

export class TxFlowClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'txflow'

  private readonly inflightStates = new Map<string, Promise<TxFlowClearinghouseState>>()

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${TXFLOW_API_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TXFLOW_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`TxFlow API error: ${response.status} - ${errorText}`)
    }

    return response.json()
  }

  // getAccountBalance와 getPositions가 같은 응답을 쓰므로, 동시에 호출되면 진행 중인 요청을 공유한다
  // (완료된 결과는 캐시하지 않음)
  private fetchClearinghouseState(address: string): Promise<TxFlowClearinghouseState> {
    const key = address.toLowerCase()
    const inflight = this.inflightStates.get(key)
    if (inflight) return inflight

    const request = this.post<TxFlowClearinghouseState>({ type: 'clearinghouseState', user: address })
      .then((state) => {
        if (!Array.isArray(state?.assetPositions) || !state.marginSummary) {
          throw new Error('Unexpected TxFlow response: missing clearinghouseState fields')
        }
        return state
      })
      .finally(() => this.inflightStates.delete(key))
    this.inflightStates.set(key, request)
    return request
  }

  async getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const state = await this.fetchClearinghouseState(address)
      return this.createSuccessResponse(state.assetPositions.map((ap) => this.transformPosition(ap)))
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getSpotBalances(query?: AddressQuery): Promise<ExchangeResponse<SpotBalance[]>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      // perp 담보와 spot 잔고는 별도 계정 (perp accountValue와 이중 계상되지 않음)
      const state = await this.post<TxFlowSpotClearinghouseState>({
        type: 'spotClearinghouseState',
        user: address,
      })

      if (!Array.isArray(state?.balances)) {
        throw new Error('Unexpected TxFlow response: missing balances')
      }

      const spotBalances: SpotBalance[] = state.balances
        .filter((b) => parseFloat(b.total) !== 0)
        .map((b) => ({ symbol: b.coin, balance: b.total, lockedBalance: b.hold || '0' }))

      return this.createSuccessResponse(spotBalances)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch spot balances'
      )
    }
  }

  async getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const state = await this.fetchClearinghouseState(address)
      const ms = state.marginSummary
      let unrealizedPnl = 0
      for (const ap of state.assetPositions) {
        unrealizedPnl += parseFloat(ap.position.unrealizedPnl) || 0
      }

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity: requireNumber(ms.accountValue, 'accountValue'),
        availableBalance: parseFloat(state.withdrawable || '0') || 0,
        usedMargin: parseFloat(ms.totalMarginUsed) || 0,
        unrealizedPnl,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private transformPosition(ap: TxFlowAssetPosition): Position {
    const pos = ap.position
    const szi = requireNumber(pos.szi, 'szi')
    const side = szi > 0 ? 'long' : 'short'
    // coin은 "BTC-USDC" 형태
    const baseAsset = pos.coin.replace(/-USDC$/, '')
    const market = `${baseAsset}-PERP`
    const tpsl = ap.tpsl?.[0]

    return {
      id: generatePositionId(this.exchangeId, market, side),
      exchange: this.exchangeId,
      market,
      baseAsset,
      side,
      size: Math.abs(szi),
      sizeUsd: Math.abs(requireNumber(pos.positionValue, 'positionValue')),
      entryPrice: requireNumber(pos.entryPx, 'entryPx'),
      markPrice: requireNumber(pos.markPx, 'markPx'),
      unrealizedPnl: requireNumber(pos.unrealizedPnl, 'unrealizedPnl'),
      // Hyperliquid와 달리 이미 퍼센트 단위
      unrealizedPnlPercent: parseFloat(pos.returnOnEquity) || 0,
      leverage: pos.leverage?.value || 1,
      liquidationPrice: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
      stopLoss: tpsl?.slTriggerPrice ? parseFloat(tpsl.slTriggerPrice) : null,
      takeProfit: tpsl?.tpTriggerPrice ? parseFloat(tpsl.tpTriggerPrice) : null,
      margin: requireNumber(pos.marginUsed, 'marginUsed'),
      marginRatio: null,
      createdAt: null,
      updatedAt: new Date(),
    }
  }
}
