import type { ExchangeId, Position, AccountBalance, ExchangeResponse, AddressQuery } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId, isValidEvmAddress } from '../utils'

const HYPERLIQUID_API_BASE = 'https://api.hyperliquid.xyz'

interface HyperliquidAssetPosition {
  position: {
    coin: string
    szi: string
    leverage: { type: string; value: number }
    entryPx: string
    positionValue: string
    unrealizedPnl: string
    returnOnEquity: string
    liquidationPx: string | null
    marginUsed: string
    maxTradeSzs: [string, string]
    cumFunding: { allTime: string; sinceOpen: string; sinceChange: string }
  }
  type: string
}

interface HyperliquidClearinghouseState {
  assetPositions: HyperliquidAssetPosition[]
  crossMarginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
    withdrawable: string
  }
  marginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
  }
  crossMaintenanceMarginUsed: string
}

interface HyperliquidOpenOrder {
  coin: string
  oid: number
  side: string
  sz: string
  limitPx: string
  orderType?: string
  reduceOnly: boolean
  triggerCondition?: string
  triggerPx?: string
  isTrigger?: boolean
  isPositionTpsl?: boolean
  origSz?: string
  timestamp?: number
}

export class HyperliquidClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'hyperliquid'

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${HYPERLIQUID_API_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Hyperliquid API error: ${response.status} - ${errorText}`)
    }

    return response.json()
  }

  async getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const state = await this.post<HyperliquidClearinghouseState>({
        type: 'clearinghouseState',
        user: address,
      })

      let frontendOrders: HyperliquidOpenOrder[] = []
      try {
        frontendOrders = await this.post<HyperliquidOpenOrder[]>({
          type: 'frontendOpenOrders',
          user: address,
        })
      } catch {
        // silently ignore order fetch failures
      }

      const slTpMap = this.extractSlTpFromOrders(frontendOrders)
      const positions = this.transformPositions(state.assetPositions, slTpMap)

      return this.createSuccessResponse(positions)
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
      const state = await this.post<HyperliquidClearinghouseState>({
        type: 'clearinghouseState',
        user: address,
      })

      const marginSummary = state.crossMarginSummary || state.marginSummary

      let totalUnrealizedPnl = 0
      for (const ap of state.assetPositions) {
        totalUnrealizedPnl += parseFloat(ap.position.unrealizedPnl) || 0
      }

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity: parseFloat(marginSummary.accountValue) || 0,
        availableBalance: parseFloat(state.crossMarginSummary?.withdrawable || '0') || 0,
        usedMargin: parseFloat(marginSummary.totalMarginUsed) || 0,
        unrealizedPnl: totalUnrealizedPnl,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private extractSlTpFromOrders(
    orders: HyperliquidOpenOrder[]
  ): Map<string, { stopLoss: number | null; takeProfit: number | null }> {
    const slTpMap = new Map<string, { stopLoss: number | null; takeProfit: number | null }>()

    const tpslOrders = orders.filter(
      (o) => o.isTrigger && o.isPositionTpsl && o.triggerPx
    )

    for (const order of tpslOrders) {
      const coin = order.coin
      const triggerPrice = parseFloat(order.triggerPx!)

      if (isNaN(triggerPrice) || triggerPrice === 0) continue

      if (!slTpMap.has(coin)) {
        slTpMap.set(coin, { stopLoss: null, takeProfit: null })
      }

      const slTp = slTpMap.get(coin)!
      const orderType = order.orderType?.toLowerCase() || ''

      if (orderType.includes('stop') && !orderType.includes('take')) {
        slTp.stopLoss = triggerPrice
      } else if (orderType.includes('take profit') || orderType.includes('tp')) {
        slTp.takeProfit = triggerPrice
      } else {
        const triggerCond = order.triggerCondition?.toLowerCase() || ''
        if (triggerCond.includes('below')) {
          slTp.stopLoss = triggerPrice
        } else if (triggerCond.includes('above')) {
          slTp.takeProfit = triggerPrice
        }
      }
    }

    return slTpMap
  }

  private transformPositions(
    assetPositions: HyperliquidAssetPosition[],
    slTpMap: Map<string, { stopLoss: number | null; takeProfit: number | null }>
  ): Position[] {
    return assetPositions
      .filter((ap) => {
        const szi = parseFloat(ap.position.szi)
        return szi !== 0 && !isNaN(szi)
      })
      .map((ap) => {
        const pos = ap.position
        const szi = parseFloat(pos.szi)
        const size = Math.abs(szi)
        const entryPrice = parseFloat(pos.entryPx)
        const positionValue = Math.abs(parseFloat(pos.positionValue))
        const unrealizedPnl = parseFloat(pos.unrealizedPnl)
        const side = szi > 0 ? 'long' : 'short'
        const leverage = pos.leverage?.value || 1
        const margin = parseFloat(pos.marginUsed) || positionValue / leverage
        const unrealizedPnlPercent = parseFloat(pos.returnOnEquity) * 100 || 0
        const markPrice = size > 0 ? positionValue / size : entryPrice
        const liquidationPrice = pos.liquidationPx ? parseFloat(pos.liquidationPx) : null
        const baseAsset = pos.coin
        const market = `${baseAsset}-PERP`
        const slTp = slTpMap.get(baseAsset)

        return {
          id: generatePositionId(this.exchangeId, market, side),
          exchange: this.exchangeId,
          market,
          baseAsset,
          side,
          size,
          sizeUsd: positionValue,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          leverage,
          liquidationPrice,
          stopLoss: slTp?.stopLoss || null,
          takeProfit: slTp?.takeProfit || null,
          margin,
          marginRatio: null,
          createdAt: null,
          updatedAt: new Date(),
        }
      })
  }
}
