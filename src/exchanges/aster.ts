import type { ExchangeId, Position, AccountBalance, SpotBalance, ExchangeResponse, AddressQuery, AsterConfig } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId } from '../utils'
import crypto from 'crypto'

const ASTER_API_BASE = 'https://fapi.asterdex.com'
const ASTER_SPOT_API_BASE = 'https://sapi.asterdex.com'

interface AsterPositionRisk {
  symbol: string
  positionAmt: string
  entryPrice: string
  markPrice: string
  unRealizedProfit: string
  liquidationPrice: string
  leverage: string
  maxNotionalValue: string
  marginType: string
  isolatedMargin: string
  isAutoAddMargin: string
  positionSide: string
  notional: string
  isolatedWallet: string
  updateTime: number
}

interface AsterAccountInfo {
  totalWalletBalance: string
  totalMarginBalance: string
  totalUnrealizedProfit: string
  totalPositionInitialMargin: string
  availableBalance: string
  maxWithdrawAmount: string
}

interface AsterSpotAsset {
  a: string  // asset symbol
  f: string  // free balance
  l: string  // locked balance
}

interface AsterSpotAccountInfo {
  assets: AsterSpotAsset[]
}

interface AsterOpenOrder {
  orderId: number
  symbol: string
  status: string
  clientOrderId: string
  price: string
  avgPrice: string
  origQty: string
  executedQty: string
  cumQuote: string
  timeInForce: string
  type: string
  reduceOnly: boolean
  closePosition: boolean
  side: string
  positionSide: string
  stopPrice: string
  workingType: string
  priceProtect: boolean
  origType: string
  time: number
  updateTime: number
}

function createSignature(queryString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

export class AsterClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'aster'
  private baseUrl: string
  private apiKey: string
  private apiSecret: string

  constructor(config: AsterConfig, baseUrl = ASTER_API_BASE) {
    super()
    this.baseUrl = baseUrl
    this.apiKey = config.apiKey
    this.apiSecret = config.apiSecret
  }

  private async signedRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    baseUrl?: string
  ): Promise<T> {
    const timestamp = Date.now().toString()
    const queryParams = new URLSearchParams({ ...params, timestamp })
    const signature = createSignature(queryParams.toString(), this.apiSecret)
    queryParams.append('signature', signature)

    const url = `${baseUrl || this.baseUrl}${endpoint}?${queryParams.toString()}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Aster API error: ${response.status} - ${errorText}`)
    }

    return response.json()
  }

  async getSpotBalances(_query?: AddressQuery): Promise<ExchangeResponse<SpotBalance[]>> {
    try {
      const accountInfo = await this.signedRequest<AsterSpotAccountInfo>(
        '/api/v1/account',
        {},
        ASTER_SPOT_API_BASE
      )

      const assets = accountInfo.assets || []

      const spotBalances: SpotBalance[] = assets
        .filter((a) => {
          const free = parseFloat(a.f) || 0
          const locked = parseFloat(a.l) || 0
          return free + locked !== 0
        })
        .map((a) => ({
          symbol: a.a,
          balance: (parseFloat(a.f) + parseFloat(a.l)).toString(),
          lockedBalance: a.l || '0',
        }))

      return this.createSuccessResponse(spotBalances)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch spot balances'
      )
    }
  }

  async getPositions(_query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    try {
      const positions = await this.signedRequest<AsterPositionRisk[]>('/fapi/v2/positionRisk')

      let openOrders: AsterOpenOrder[] = []
      try {
        openOrders = await this.signedRequest<AsterOpenOrder[]>('/fapi/v1/openOrders')
      } catch {
        // silently ignore order fetch failures
      }

      const slTpMap = this.extractSlTpFromOrders(openOrders)
      const transformedPositions = this.transformPositions(positions, slTpMap)

      return this.createSuccessResponse(transformedPositions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getAccountBalance(_query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    try {
      const accountInfo = await this.signedRequest<AsterAccountInfo>('/fapi/v2/account')

      const availableBalance = parseFloat(accountInfo.availableBalance) || 0
      const usedMargin = parseFloat(accountInfo.totalPositionInitialMargin) || 0
      const unrealizedPnl = parseFloat(accountInfo.totalUnrealizedProfit) || 0
      const totalEquity = availableBalance + usedMargin + unrealizedPnl

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity,
        availableBalance,
        usedMargin,
        unrealizedPnl,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private extractSlTpFromOrders(
    orders: AsterOpenOrder[]
  ): Map<string, { stopLoss: number | null; takeProfit: number | null }> {
    const slTpMap = new Map<string, { stopLoss: number | null; takeProfit: number | null }>()

    for (const order of orders) {
      const symbol = order.symbol
      if (!slTpMap.has(symbol)) {
        slTpMap.set(symbol, { stopLoss: null, takeProfit: null })
      }

      const slTp = slTpMap.get(symbol)!
      const stopPrice = parseFloat(order.stopPrice)

      if (
        order.type === 'STOP_MARKET' ||
        order.type === 'STOP' ||
        order.origType === 'STOP_MARKET'
      ) {
        slTp.stopLoss = stopPrice || null
      } else if (
        order.type === 'TAKE_PROFIT_MARKET' ||
        order.type === 'TAKE_PROFIT' ||
        order.origType === 'TAKE_PROFIT_MARKET'
      ) {
        slTp.takeProfit = stopPrice || null
      }
    }

    return slTpMap
  }

  private transformPositions(
    positions: AsterPositionRisk[],
    slTpMap: Map<string, { stopLoss: number | null; takeProfit: number | null }>
  ): Position[] {
    return positions
      .filter((p) => {
        const positionAmt = parseFloat(p.positionAmt)
        return positionAmt !== 0 && !isNaN(positionAmt)
      })
      .map((p) => {
        const positionAmt = parseFloat(p.positionAmt)
        const size = Math.abs(positionAmt)
        const entryPrice = parseFloat(p.entryPrice)
        const markPrice = parseFloat(p.markPrice)
        const unrealizedPnl = parseFloat(p.unRealizedProfit)
        const leverage = parseInt(p.leverage, 10) || 1
        const notional = Math.abs(parseFloat(p.notional))
        const side = positionAmt > 0 ? 'long' : 'short'
        const margin = notional / leverage
        const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0
        const baseAsset = p.symbol.replace(/USDT$|USDC$|USD$/, '')
        const market = `${baseAsset}-PERP`
        const slTp = slTpMap.get(p.symbol)

        return {
          id: generatePositionId(this.exchangeId, market, side),
          exchange: this.exchangeId,
          market,
          baseAsset,
          side,
          size,
          sizeUsd: notional,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          leverage,
          liquidationPrice: parseFloat(p.liquidationPrice) || null,
          stopLoss: slTp?.stopLoss || null,
          takeProfit: slTp?.takeProfit || null,
          margin,
          marginRatio: null,
          createdAt: null,
          updatedAt: new Date(p.updateTime),
        }
      })
  }
}
