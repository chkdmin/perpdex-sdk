import type { ExchangeId, Position, AccountBalance, ExchangeResponse, AddressQuery } from '../types'
import { BaseClient } from './base-client'
import { extractBaseAsset, generatePositionId } from '../utils'

export function mapCcxtPosition(p: Record<string, unknown>, exchangeId: ExchangeId): Position {
  const symbol = (p.symbol as string) ?? ''
  const side = (p.side as 'long' | 'short') ?? 'long'
  const contracts = (p.contracts as number) ?? 0
  const contractSize = (p.contractSize as number) ?? 1

  return {
    id: generatePositionId(exchangeId, symbol, side),
    exchange: exchangeId,
    market: symbol,
    baseAsset: extractBaseAsset(symbol),
    side,
    size: contracts * contractSize,
    sizeUsd: (p.notional as number) ?? 0,
    entryPrice: (p.entryPrice as number) ?? 0,
    markPrice: (p.markPrice as number) ?? 0,
    unrealizedPnl: (p.unrealizedPnl as number) ?? 0,
    unrealizedPnlPercent: (p.percentage as number) ?? 0,
    leverage: (p.leverage as number) ?? 1,
    liquidationPrice: (p.liquidationPrice as number) ?? null,
    stopLoss: (p.stopLossPrice as number) ?? null,
    takeProfit: (p.takeProfitPrice as number) ?? null,
    margin: (p.initialMargin as number) ?? (p.collateral as number) ?? 0,
    marginRatio: (p.marginRatio as number) ?? null,
    createdAt: null,
    updatedAt: p.timestamp ? new Date(p.timestamp as number) : new Date(),
  }
}

export abstract class CcxtAdapter extends BaseClient {
  protected ccxtExchange: any

  async getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    try {
      const raw: Record<string, unknown>[] = await this.ccxtExchange.fetchPositions()
      const positions = raw
        .filter((p: any) => p.contracts && Number(p.contracts) > 0)
        .map((p: any) => mapCcxtPosition(p, this.exchangeId))
      return this.createSuccessResponse(positions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  abstract getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>>
}
