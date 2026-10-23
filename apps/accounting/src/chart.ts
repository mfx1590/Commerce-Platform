// The default chart of accounts (#548). One copy per legal entity in `ledger_account`, seeded by the consumer the
// first time it posts for that legal entity (INSERT … ON CONFLICT DO NOTHING); the owner's accountant renames or
// extends it before launch (launch checklist). Codes are what the posting rules reference — they never change.
export const ACCOUNT = {
  BANK: '1000',
  PSP_CLEARING: '1100',
  RECEIVABLE: '1200',
  CARRIER_PAYABLE: '2100',
  VAT_PAYABLE: '2200',
  CONTRACT_LIABILITY_GOODS: '2300',
  CONTRACT_LIABILITY_SHIPPING: '2310',
  REVENUE_GOODS: '4000',
  REVENUE_SHIPPING: '4010',
  REFUNDS: '4090',
  SHIPPING_COST: '6000',
  PSP_FEES: '6100',
} as const;

export type AccountCode = (typeof ACCOUNT)[keyof typeof ACCOUNT];
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface ChartAccount {
  code: AccountCode;
  name: string;
  type: AccountType;
}

export const DEFAULT_CHART: readonly ChartAccount[] = [
  { code: ACCOUNT.BANK, name: 'Bank', type: 'asset' },
  { code: ACCOUNT.PSP_CLEARING, name: 'PSP clearing (captured, not paid out)', type: 'asset' },
  { code: ACCOUNT.RECEIVABLE, name: 'Accounts receivable — trade', type: 'asset' },
  { code: ACCOUNT.CARRIER_PAYABLE, name: 'Carrier payable', type: 'liability' },
  { code: ACCOUNT.VAT_PAYABLE, name: 'VAT payable', type: 'liability' },
  { code: ACCOUNT.CONTRACT_LIABILITY_GOODS, name: 'Contract liability — goods', type: 'liability' },
  {
    code: ACCOUNT.CONTRACT_LIABILITY_SHIPPING,
    name: 'Contract liability — shipping',
    type: 'liability',
  },
  { code: ACCOUNT.REVENUE_GOODS, name: 'Revenue — goods', type: 'revenue' },
  { code: ACCOUNT.REVENUE_SHIPPING, name: 'Revenue — shipping', type: 'revenue' },
  { code: ACCOUNT.REFUNDS, name: 'Refunds and allowances (contra revenue)', type: 'revenue' },
  { code: ACCOUNT.SHIPPING_COST, name: 'Shipping cost', type: 'expense' },
  { code: ACCOUNT.PSP_FEES, name: 'PSP fees', type: 'expense' },
];
