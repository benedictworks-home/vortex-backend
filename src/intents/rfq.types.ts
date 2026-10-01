import { SupportedChain } from "./intents.types";

export interface RfqQuoteRequest {
  requestId: string;
  srcChain: SupportedChain;
  srcTokenSymbol: string;
  srcAmount: string;
  dstTokenSymbol: string;
  srcTokenAddress?: string;
  dstTokenContract?: string;
  deadline: number;
}

export interface RfqResponseSignaturePayload extends RfqQuoteRequest {
  solver: string;
  dstAmount: string;
  fee: string;
  expiresAt: number;
}

export interface RfqQuoteResponse {
  type: "rfq_response";
  requestId: string;
  dstAmount: string;
  fee: string;
  expiresAt: number;
  signature: string;
}

export interface VerifiedRfqQuote {
  solver: string;
  dstAmount: string;
  fee: string;
  expiresAt: number;
}