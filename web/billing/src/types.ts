export interface Envelope<T> {
  payload: T;
  signatures: { key: string; signature: string }[];
}
export type PaymentState = "paid" | "verification_pending" | "unpaid";
export interface InvoiceRow {
  invoice_id: string;
  invoice_number: string;
  payment_state: PaymentState;
  collection_state: "open" | "stopped" | "window_closed";
  issued_at: number;
  payable_until: number;
  period_id: string;
  amount_zatoshis: string;
  service_from: number;
  service_until: number;
  txid: string | null;
  last_verified_at: number | null;
  has_billing_document: boolean;
}
export interface BillingList {
  invoices: InvoiceRow[];
  next_cursor: string | null;
  currency: "TAZ";
  as_of: number;
  totals: {
    billed_zatoshis: string;
    paid_zatoshis: string;
    pending_zatoshis: string;
    unpaid_zatoshis: string;
    invoice_count: number;
    paid_count: number;
    pending_count: number;
    unpaid_count: number;
  };
  agreement: {
    agreement_id: string;
    buyer_company_id: string;
    supplier_key: string;
    amount_zatoshis: string;
    expires_at: number;
    revoked: boolean;
    schedule: { kind: string; interval_secs?: number };
  } | null;
}
export interface PaymentRequest {
  invoice_id: string;
  agreement_id: string;
  agreement_digest: string;
  recipient: string;
  issued_at: number;
  expires_at: number;
  amount_zatoshis: string;
  period_id: string;
  context: { company_id: string; signer_id: string; chain: string };
}
export interface BillingDocument {
  invoice_number: string;
  invoice_id: string;
  invoice_digest: string;
  document_created_at: number;
  payment_request_issued_at: number;
  payable_until: number;
  service_from: number;
  service_until: number;
  buyer_company_id: string;
  supplier_key: string;
  currency: "TAZ";
  total_zatoshis: string;
  tax_treatment: "not_calculated";
  line_items: {
    description: string;
    quantity: number;
    unit_amount_zatoshis: string;
  }[];
}
export interface InvoiceDetail {
  invoice_id: string;
  invoice_number: string;
  payment_state: PaymentState;
  collection_state: string;
  issued: {
    envelope: Envelope<PaymentRequest>;
    period_start: number;
    service_until: number;
    payment_memo: string;
  };
  billing_document: Envelope<BillingDocument> | null;
  document_signature_verified: boolean;
  txid: string | null;
  as_of: number;
  payment_candidate: null | {
    txid: string;
    attempted_at: number;
    last_error: string | null;
  };
  receipt: null | {
    txid: string;
    amount_zatoshis: string;
    memo: string;
    confirmations: number;
    mined_height: number;
    verified_tip: number;
    observed_at: number;
  };
}
