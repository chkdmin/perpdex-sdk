import type { ExchangeId, Position, AccountBalance, ExchangeResponse, AddressQuery } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId, isValidEvmAddress } from '../utils'

// https://docs.arcus.xyz/api-reference/introduction — 계정 조회는 인증 없이 주소로 가능
const ARCUS_API_BASE = 'https://api.arcus.xyz/v1'
// 응답 없이 멈춘 요청이 소비자의 순차 sync 루프를 막지 않도록 본문 수신까지 포함해 끊는다
const ARCUS_REQUEST_TIMEOUT_MS = 15_000
// 접근 권한은 있지만 입금·주문 이력이 없는 계정 (404). 접근 권한이 없는 주소는 403이며 실패로 둔다
const NO_ACTIVITY_ERROR = 'this account has no activity yet'

interface ArcusPosition {
  marketId: number
  marketDisplayName: string
  size: string
  averageEntryPrice: string
  leverage: string
  marginUsed: string
  positionValueNotional: string
  unrealizedPnl: string
  markPx: string
}

// 서브계정(accountIndex 1~9)은 API로만 만들 수 있어 기본 계정(0)만 조회한다
interface ArcusAccount {
  // spot 담보(Multi-Asset Collateral)가 있으면 그 가치를 포함하고 대출은 차감된 값
  equity: string
  // spot 담보 가치는 제외되므로 음수일 수 있다
  freeCollateral: string
  positions: Record<string, ArcusPosition>
}

interface ArcusOrder {
  marketId: number
  triggerPrice?: string
  tpslType?: 'STOP_LOSS' | 'TAKE_PROFIT'
  isPositionTPSL?: boolean
}

type SlTp = { stopLoss: number | null; takeProfit: number | null }

class ArcusApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Arcus API error: ${status} - ${body}`)
  }
}

// 형식이 깨진 200 응답을 0으로 바꿔 성공 처리하면 소비자가 기존 자산을 지우므로 실패로 던진다
function requireNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? parseFloat(String(value)) : NaN
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unexpected Arcus response: invalid ${field}`)
  }
  return parsed
}

export class ArcusClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'arcus'

  private readonly inflightAccounts = new Map<string, Promise<ArcusAccount | null>>()

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const response = await fetch(`${ARCUS_API_BASE}${path}?${new URLSearchParams(params)}`, {
      signal: AbortSignal.timeout(ARCUS_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new ArcusApiError(response.status, await response.text())
    }

    return response.json()
  }

  // getAccountBalance와 getPositions가 같은 응답을 쓰므로, 동시에 호출되면 진행 중인 요청을 공유한다
  // (완료된 결과는 캐시하지 않음). 활동 이력이 없는 계정은 null
  private fetchAccount(address: string): Promise<ArcusAccount | null> {
    const key = address.toLowerCase()
    const inflight = this.inflightAccounts.get(key)
    if (inflight) return inflight

    const request = this.get<ArcusAccount>('/account', { address })
      .then((account) => {
        if (!account?.positions || typeof account.positions !== 'object') {
          throw new Error('Unexpected Arcus response: missing account fields')
        }
        return account
      })
      .catch((error) => {
        if (error instanceof ArcusApiError && error.status === 404 && error.body.includes(NO_ACTIVITY_ERROR)) {
          return null
        }
        throw error
      })
      .finally(() => this.inflightAccounts.delete(key))
    this.inflightAccounts.set(key, request)
    return request
  }

  async getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const account = await this.fetchAccount(address)
      const positions = account ? Object.values(account.positions) : []
      if (positions.length === 0) return this.createSuccessResponse([])

      let slTpMap = new Map<number, SlTp>()
      try {
        // 최신순 1000개 제한보다 status 필터가 먼저 적용된다 — 걸려 있는 TP/SL만 받는다
        const { orders } = await this.get<{ orders: ArcusOrder[] }>('/openOrders', {
          address,
          status: 'UNTRIGGERED',
        })
        slTpMap = this.extractSlTpFromOrders(orders)
      } catch {
        // SL/TP 조회 실패는 무시 (포지션은 그대로 반환)
      }

      return this.createSuccessResponse(positions.map((pos) => this.transformPosition(pos, slTpMap)))
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const account = await this.fetchAccount(address)
      if (!account) {
        return this.createSuccessResponse({
          exchange: this.exchangeId,
          totalEquity: 0,
          availableBalance: 0,
          usedMargin: 0,
          unrealizedPnl: 0,
        })
      }

      let usedMargin = 0
      let unrealizedPnl = 0
      for (const pos of Object.values(account.positions)) {
        usedMargin += parseFloat(pos.marginUsed) || 0
        unrealizedPnl += parseFloat(pos.unrealizedPnl) || 0
      }

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity: requireNumber(account.equity, 'equity'),
        availableBalance: Math.max(0, parseFloat(account.freeCollateral) || 0),
        usedMargin,
        unrealizedPnl,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  // 수량을 지정한 부분 TP/SL은 제외하고 포지션 전체에 걸린 TP/SL만 사용
  private extractSlTpFromOrders(orders: ArcusOrder[]): Map<number, SlTp> {
    const slTpMap = new Map<number, SlTp>()

    for (const order of orders) {
      if (!order.tpslType || !order.isPositionTPSL) continue
      const triggerPrice = parseFloat(order.triggerPrice ?? '')
      if (!Number.isFinite(triggerPrice) || triggerPrice === 0) continue

      const slTp = slTpMap.get(order.marketId) ?? { stopLoss: null, takeProfit: null }
      if (order.tpslType === 'STOP_LOSS') slTp.stopLoss = triggerPrice
      else slTp.takeProfit = triggerPrice
      slTpMap.set(order.marketId, slTp)
    }

    return slTpMap
  }

  private transformPosition(pos: ArcusPosition, slTpMap: Map<number, SlTp>): Position {
    const size = requireNumber(pos.size, 'size')
    const side = size > 0 ? 'long' : 'short'
    // marketDisplayName은 "BTC-USD", "NVDA-USD" 형태
    const baseAsset = pos.marketDisplayName.replace(/-USD$/, '')
    const market = `${baseAsset}-PERP`
    const margin = requireNumber(pos.marginUsed, 'marginUsed')
    const unrealizedPnl = requireNumber(pos.unrealizedPnl, 'unrealizedPnl')
    const slTp = slTpMap.get(pos.marketId)

    return {
      id: generatePositionId(this.exchangeId, market, side),
      exchange: this.exchangeId,
      market,
      baseAsset,
      side,
      size: Math.abs(size),
      sizeUsd: Math.abs(requireNumber(pos.positionValueNotional, 'positionValueNotional')),
      entryPrice: requireNumber(pos.averageEntryPrice, 'averageEntryPrice'),
      markPrice: requireNumber(pos.markPx, 'markPx'),
      unrealizedPnl,
      // 응답에 ROE가 없어 사용 증거금 대비로 계산 (Hyperliquid returnOnEquity와 같은 기준)
      unrealizedPnlPercent: margin > 0 ? (unrealizedPnl / margin) * 100 : 0,
      leverage: parseFloat(pos.leverage) || 1,
      // 응답에 청산가가 없다
      liquidationPrice: null,
      stopLoss: slTp?.stopLoss ?? null,
      takeProfit: slTp?.takeProfit ?? null,
      margin,
      marginRatio: null,
      createdAt: null,
      updatedAt: new Date(),
    }
  }
}
