import type { ExchangeId, Position, AccountBalance, ExchangeResponse, AddressQuery, ExtendedConfig } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId } from '../utils'

const EXTENDED_API_BASE = 'https://api.starknet.extended.exchange'

interface ExtendedRawPosition {
  id: number
  accountId: number
  market: string
  side: 'LONG' | 'SHORT'
  leverage: string
  size: string
  value: string
  openPrice: string
  markPrice: string
  liquidationPrice: string | null
  margin: string
  unrealisedPnl: string
  realisedPnl: string
  tpTriggerPrice?: string | null
  tpLimitPrice?: string | null
  slTriggerPrice?: string | null
  slLimitPrice?: string | null
  adl: string
  maxPositionSize: string
  createdTime: number
  updatedTime: number
}

interface ExtendedPositionsResponse {
  status: 'OK' | 'ERROR'
  data: ExtendedRawPosition[]
  error?: {
    code: string | number
    message: string
  }
}

interface ExtendedBalanceData {
  collateralName: string
  balance: string
  equity: string
  availableForTrade: string
  availableForWithdrawal: string
  unrealisedPnl: string
  initialMargin: string
  marginRatio: string
  exposure: string
  leverage: string
  updatedTime: number
}

interface ExtendedBalanceResponse {
  status: 'OK' | 'ERROR'
  data: ExtendedBalanceData
  error?: {
    code: string | number
    message: string
  }
}

export class ExtendedClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'extended'
  private apiKey: string

  constructor(config: ExtendedConfig) {
    super()
    this.apiKey = config.apiKey
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    }

    if (this.apiKey) {
      headers['X-Api-Key'] = this.apiKey
    }

    return headers
  }

  private async get<T>(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const queryString = Object.keys(params)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&')

    const url = queryString
      ? `${EXTENDED_API_BASE}${endpoint}?${queryString}`
      : `${EXTENDED_API_BASE}${endpoint}`

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Extended API error: ${response.status} - ${errorText}`)
    }

    return response.json()
  }

  async getPositions(_query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    try {
      const response = await this.get<ExtendedPositionsResponse>('/api/v1/user/positions')

      if (response.status !== 'OK') {
        const errorMsg = response.error?.message || `API Error: ${response.status}`
        return this.createErrorResponse(errorMsg)
      }

      const positions = this.transformPositions(response.data || [])
      return this.createSuccessResponse(positions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getAccountBalance(_query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    try {
      const response = await this.get<ExtendedBalanceResponse>('/api/v1/user/balance')

      if (response.status !== 'OK' || !response.data) {
        const errorMsg = response.error?.message || `API Error: ${response.status}`
        return this.createErrorResponse(errorMsg)
      }

      const data = response.data

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity: parseFloat(data.equity) || 0,
        availableBalance: parseFloat(data.availableForTrade) || 0,
        usedMargin: parseFloat(data.initialMargin) || 0,
        unrealizedPnl: parseFloat(data.unrealisedPnl) || 0,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private transformPositions(positions: ExtendedRawPosition[]): Position[] {
    return positions
      .filter((p) => {
        const size = parseFloat(p.size)
        return size !== 0 && !isNaN(size)
      })
      .map((p) => {
        const size = Math.abs(parseFloat(p.size))
        const entryPrice = parseFloat(p.openPrice)
        const markPrice = parseFloat(p.markPrice)
        const unrealizedPnl = parseFloat(p.unrealisedPnl)
        const leverage = parseFloat(p.leverage) || 1
        const sizeUsd = parseFloat(p.value) || size * markPrice
        const margin = sizeUsd / leverage
        const side = p.side === 'LONG' ? 'long' : 'short'
        const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0
        const baseAsset = p.market.split('-')[0] || p.market
        const market = `${baseAsset}-PERP`
        const liquidationPrice = p.liquidationPrice ? parseFloat(p.liquidationPrice) : null

        return {
          id: generatePositionId(this.exchangeId, p.market, side),
          exchange: this.exchangeId,
          market,
          baseAsset,
          side,
          size,
          sizeUsd,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          leverage,
          liquidationPrice:
            liquidationPrice && !isNaN(liquidationPrice) ? liquidationPrice : null,
          stopLoss: p.slTriggerPrice ? parseFloat(p.slTriggerPrice) : null,
          takeProfit: p.tpTriggerPrice ? parseFloat(p.tpTriggerPrice) : null,
          margin,
          marginRatio: null,
          createdAt: p.createdTime ? new Date(p.createdTime) : null,
          updatedAt: p.updatedTime ? new Date(p.updatedTime) : new Date(),
        }
      })
  }
}
