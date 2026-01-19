# Core Module

Bank-agnostic domain models and transaction normalization.

**Dependency rule**: MUST NOT import from `../banks/*`

## Exports

- `Transaction` - Unified transaction type
- `BankTransactionInput` - Input for normalization (bank-agnostic)
- `makeTxnKey()` - Generate deterministic transaction keys
- `normalizeTransaction()` - Normalize any bank's transaction
- `normalizeTransactions()` - Batch normalization
