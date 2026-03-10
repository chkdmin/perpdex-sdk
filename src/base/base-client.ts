import type { ExchangeClient, ExchangeId, ExchangeResponse, Position, AccountBalance, AddressQuery } from '../types'

export abstract class BaseClient implements ExchangeClient {
  abstract readonly exchangeId: ExchangeId

  abstract getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>>
  abstract getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>>

  protected createSuccessResponse<T>(data: T): ExchangeResponse<T> {
    return { success: true, data, error: null, exchange: this.exchangeId }
  }

  protected createErrorResponse<T>(error: string): ExchangeResponse<T> {
    return { success: false, data: null, error, exchange: this.exchangeId }
  }
}
