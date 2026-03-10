# @perpdex/sdk

Unified SDK for fetching positions and balances from perpetual DEXes.

## Supported Exchanges

| Exchange | Auth | Method |
|----------|------|--------|
| Hyperliquid | address | Direct API |
| Lighter | API key | Direct API |
| Aster | API key | Direct API |
| Backpack | API key (ED25519) | Direct API |
| Pacifica | address | Direct API |
| GRVT | API key | Direct API |
| Extended | API key | Direct API |
| StandX | JWT | Direct API |

## Installation

```bash
npm install @perpdex/sdk
```

## Usage

```typescript
import { createClient } from '@perpdex/sdk'

// Address-based exchange
const hl = createClient('hyperliquid')
const positions = await hl.getPositions({ address: '0x...' })
const balance = await hl.getAccountBalance({ address: '0x...' })

// API key-based exchange
const lighter = createClient('lighter', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
})
const positions = await lighter.getPositions()
const balance = await lighter.getAccountBalance()

// JWT-based exchange
const standx = createClient('standx', { jwtToken: 'your-jwt-token' })
```

## License

MIT
