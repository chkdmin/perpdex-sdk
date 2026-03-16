import type { ExchangeId, Position, AccountBalance, SpotBalance, ExchangeResponse, AddressQuery, BackpackConfig } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId } from '../utils'

const BACKPACK_API_BASE = 'https://api.backpack.exchange'

interface BackpackPosition {
  symbol: string
  netQuantity: string
  netCost: string
  netExposureQuantity: string
  netExposureNotional: string
  entryPrice: string
  markPrice: string
  breakEvenPrice?: string
  estLiquidationPrice: string | null
  pnlUnrealized: string
  pnlRealized: string
  cumulativeFundingPayment?: string
  cumulativeInterest?: string
  imf: string
  mmf: string
  positionId?: string
  userId?: number
  subaccountId?: number
}

interface BackpackOrder {
  id: string
  clientId?: number
  createdAt: number
  executedQuantity: string
  executedQuoteQuantity: string
  postOnly: boolean
  price: string
  quantity: string
  reduceOnly?: boolean
  selfTradePrevention: string
  status: string
  side: string
  symbol: string
  timeInForce: string
  stopLossTriggerPrice?: string
  stopLossLimitPrice?: string
  stopLossTriggerBy?: string
  takeProfitTriggerPrice?: string
  takeProfitLimitPrice?: string
  takeProfitTriggerBy?: string
  triggerPrice?: string
  triggerBy?: string
  triggerQuantity?: string
  triggeredAt?: number
  relatedOrderId?: string
  strategyId?: string
}

type SlTpMap = Map<string, { stopLoss: number | null; takeProfit: number | null }>

export class BackpackClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'backpack'
  private apiKey: string
  private privateKey: Uint8Array | null = null

  constructor(config: BackpackConfig) {
    super()
    this.apiKey = config.apiKey

    try {
      if (config.apiSecret) {
        this.privateKey = Uint8Array.from(Buffer.from(config.apiSecret, 'base64'))
      }
    } catch {
      this.privateKey = null
    }
  }

  private async generateSignature(
    instruction: string,
    params: Record<string, string> = {},
    timestamp: number,
    window: number = 5000
  ): Promise<string> {
    if (!this.privateKey) {
      throw new Error('Private key not set')
    }

    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&')

    const message = sortedParams
      ? `instruction=${instruction}&${sortedParams}&timestamp=${timestamp}&window=${window}`
      : `instruction=${instruction}&timestamp=${timestamp}&window=${window}`

    // Lazy-load ed25519
    const { hashes, signAsync } = await import('@noble/ed25519')
    const { createHash } = await import('crypto')

    // Set sha512 hash for Node.js compatibility
    hashes.sha512 = (msg: Uint8Array) => {
      return new Uint8Array(createHash('sha512').update(msg).digest())
    }

    const messageBytes = new TextEncoder().encode(message)
    const signature = await signAsync(messageBytes, this.privateKey)

    return Buffer.from(signature).toString('base64')
  }

  private async authenticatedGet<T>(
    endpoint: string,
    instruction: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const timestamp = Date.now()
    const window = 5000
    const signature = await this.generateSignature(instruction, params, timestamp, window)

    const queryString = Object.keys(params)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&')
    const url = queryString
      ? `${BACKPACK_API_BASE}${endpoint}?${queryString}`
      : `${BACKPACK_API_BASE}${endpoint}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': this.apiKey,
        'X-Signature': signature,
        'X-Timestamp': timestamp.toString(),
        'X-Window': window.toString(),
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Backpack API error: ${response.status} - ${errorText}`)
    }

    return response.json()
  }

  private async getOpenOrders(): Promise<BackpackOrder[]> {
    try {
      const orders = await this.authenticatedGet<BackpackOrder[]>(
        '/api/v1/orders',
        'orderQueryAll',
        { marketType: 'PERP' }
      )
      return orders || []
    } catch {
      return []
    }
  }

  private extractSlTpFromOrders(orders: BackpackOrder[]): SlTpMap {
    const slTpMap: SlTpMap = new Map()

    const triggerOrders = orders.filter(
      (o) => o.status === 'TriggerPending' && o.reduceOnly && o.triggerPrice
    )

    const ordersBySymbol = new Map<string, BackpackOrder[]>()
    for (const order of triggerOrders) {
      if (!ordersBySymbol.has(order.symbol)) {
        ordersBySymbol.set(order.symbol, [])
      }
      ordersBySymbol.get(order.symbol)!.push(order)
    }

    for (const [symbol, symbolOrders] of ordersBySymbol) {
      if (!slTpMap.has(symbol)) {
        slTpMap.set(symbol, { stopLoss: null, takeProfit: null })
      }

      const slTp = slTpMap.get(symbol)!
      const triggerPrices = symbolOrders
        .map((o) => parseFloat(o.triggerPrice!))
        .filter((p) => !isNaN(p) && p > 0)
        .sort((a, b) => a - b)

      if (triggerPrices.length === 0) continue

      const firstOrder = symbolOrders[0]
      const isLongPosition = firstOrder.side === 'Ask'

      if (triggerPrices.length === 1) {
        slTp.stopLoss = triggerPrices[0]
      } else if (triggerPrices.length >= 2) {
        if (isLongPosition) {
          slTp.stopLoss = triggerPrices[0]
          slTp.takeProfit = triggerPrices[triggerPrices.length - 1]
        } else {
          slTp.stopLoss = triggerPrices[triggerPrices.length - 1]
          slTp.takeProfit = triggerPrices[0]
        }
      }
    }

    return slTpMap
  }

  async getSpotBalances(_query?: AddressQuery): Promise<ExchangeResponse<SpotBalance[]>> {
    if (!this.privateKey) {
      return this.createErrorResponse('Backpack API credentials not configured')
    }

    try {
      const balances = await this.authenticatedGet<
        Record<string, { available: string; locked: string; staked: string }>
      >('/api/v1/capital', 'balanceQuery')

      const spotBalances: SpotBalance[] = Object.entries(balances)
        .filter(([, v]) => {
          const total = parseFloat(v.available) + parseFloat(v.locked) + parseFloat(v.staked)
          return total !== 0
        })
        .map(([symbol, v]) => ({
          symbol,
          balance: (parseFloat(v.available) + parseFloat(v.locked) + parseFloat(v.staked)).toString(),
          lockedBalance: v.locked || '0',
        }))

      return this.createSuccessResponse(spotBalances)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch spot balances'
      )
    }
  }

  async getPositions(_query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    if (!this.privateKey) {
      return this.createErrorResponse('Backpack API credentials not configured')
    }

    try {
      const positions = await this.authenticatedGet<BackpackPosition[]>(
        '/api/v1/position',
        'positionQuery'
      )

      const collateralInfo = await this.authenticatedGet<{
        netEquityLocked: string
        netExposureFutures: string
      }>('/api/v1/capital/collateral', 'collateralQuery')

      const openOrders = await this.getOpenOrders()
      const slTpMap = this.extractSlTpFromOrders(openOrders)

      const transformedPositions = this.transformPositions(
        positions || [],
        slTpMap,
        collateralInfo
      )

      return this.createSuccessResponse(transformedPositions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getAccountBalance(_query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    if (!this.privateKey) {
      return this.createErrorResponse('Backpack API credentials not configured')
    }

    try {
      const collateralInfo = await this.authenticatedGet<{
        netEquity: string
        netEquityAvailable: string
        netEquityLocked: string
        pnlUnrealized: string
      }>('/api/v1/capital/collateral', 'collateralQuery')

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity: parseFloat(collateralInfo.netEquity) || 0,
        availableBalance: parseFloat(collateralInfo.netEquityAvailable) || 0,
        usedMargin: parseFloat(collateralInfo.netEquityLocked) || 0,
        unrealizedPnl: parseFloat(collateralInfo.pnlUnrealized) || 0,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private transformPositions(
    positions: BackpackPosition[],
    slTpMap: SlTpMap,
    collateralInfo?: { netEquityLocked: string; netExposureFutures: string }
  ): Position[] {
    return positions
      .filter((p) => {
        const qty = parseFloat(p.netQuantity)
        return qty !== 0 && !isNaN(qty)
      })
      .map((p) => {
        const netQuantity = parseFloat(p.netQuantity)
        const size = Math.abs(netQuantity)
        const entryPrice = parseFloat(p.entryPrice)
        const markPrice = parseFloat(p.markPrice)

        const notional = p.netExposureNotional
          ? Math.abs(parseFloat(p.netExposureNotional))
          : size * markPrice

        const side = netQuantity > 0 ? 'long' : 'short'

        const unrealizedPnl =
          side === 'long'
            ? (markPrice - entryPrice) * size
            : (entryPrice - markPrice) * size

        const liquidationPrice = p.estLiquidationPrice
          ? parseFloat(p.estLiquidationPrice)
          : null
        const mmf = parseFloat(p.mmf) || 0
        const imf = parseFloat(p.imf) || 0

        let leverage = 1
        if (liquidationPrice && liquidationPrice > 0 && entryPrice > 0) {
          const ratio = liquidationPrice / entryPrice
          if (side === 'long' && ratio < 1) {
            const marginFraction = 1 - ratio + mmf
            if (marginFraction > 0) leverage = 1 / marginFraction
          } else if (side === 'short' && ratio > 1) {
            const marginFraction = ratio - 1 + mmf
            if (marginFraction > 0) leverage = 1 / marginFraction
          }
        }

        const maxLeverage = imf > 0 ? 1 / imf : 100
        if (leverage < 1 || leverage > maxLeverage) {
          leverage = imf > 0 ? 1 / imf : 1
        }

        leverage = Math.round(leverage)
        const margin = notional / leverage

        const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0
        const marginRatio = mmf > 0 ? mmf * 100 : null

        const parts = p.symbol.split('_')
        const baseAsset = parts[0] || p.symbol
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
          liquidationPrice,
          stopLoss: slTp?.stopLoss ?? null,
          takeProfit: slTp?.takeProfit ?? null,
          margin,
          marginRatio,
          createdAt: null,
          updatedAt: new Date(),
        }
      })
  }
}
