import type { Address } from "viem";
import type { WalletClient } from "viem";
import {
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS,
  OrderBookApi,
  OrderQuoteSideKindSell,
  OrderSigningUtils,
  SigningScheme,
  SupportedChainId,
  buildAppData,
  getQuoteAmountsAndCosts,
} from "@cowprotocol/cow-sdk";
import type { QuoteAmountsAndCosts } from "@cowprotocol/cow-sdk";
import { COWSWAP_PARTNER_FEE_BPS, COWSWAP_PARTNER_FEE_RECIPIENT } from "../constants/config.ts";
import { getTokenInfo } from "../constants/supported-reward-tokens.ts";

interface CowSwapQuoteParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  userAddress: Address;
  chainId: number;
}

interface CowSwapQuoteResult {
  estimatedAmountOut: bigint;
  feeAmount?: bigint;
  amountsAndCosts: QuoteAmountsAndCosts;
}

interface CowSwapOrderParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  owner: Address;
  receiver: Address;
  chainId: number;
  walletClient: WalletClient;
}

const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

/**
 * Constructs an OrderQuoteRequest object formatted for the CoW Protocol OrderBook API.
 *
 * @param params - Parameters specifying tokens, accounts, amounts, and AppData metadata.
 * @returns An OrderQuoteRequest payload matching the CoW Protocol SDK schema.
 */
function buildCowQuoteRequest({
  tokenIn,
  tokenOut,
  from,
  receiver,
  amountIn,
  appDataInfo,
}: {
  tokenIn: Address;
  tokenOut: Address;
  from: Address;
  receiver: Address;
  amountIn: bigint;
  appDataInfo: { fullAppData: string; appDataKeccak256: string };
}) {
  return {
    sellToken: tokenIn,
    buyToken: tokenOut,
    from,
    receiver,
    sellAmountBeforeFee: amountIn.toString(),
    kind: OrderQuoteSideKindSell.SELL,
    appData: appDataInfo.fullAppData,
    appDataHash: appDataInfo.appDataKeccak256,
  };
}

/**
 * Validates that an OrderQuoteResponse matches the required EIP-712 Order schema
 * and verifies that critical execution parameters (receiver, tokens, amounts, kind)
 * strictly bind to the original request before wallet signing (CWE-345 mitigation).
 *
 * @param quote - The quote object returned by the CoW OrderBook API.
 * @param expected - The expected order parameters originally passed to the quote request.
 * @throws Error if any required field is missing or if parameter binding fails.
 */
export function assertQuoteMatchesRequest(
  quote: Record<string, unknown>,
  expected: {
    receiver: Address;
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
  }
) {
  const eip712Types = OrderSigningUtils.getEIP712Types() as unknown as { Order: Array<{ name: string; type: string }> };
  const required = eip712Types.Order.map((t) => t.name);
  for (const key of required) {
    if (!(key in quote)) throw new Error(`CoW quote missing required field: ${key}`);
  }

  const normalize = (addr: unknown) => (typeof addr === "string" ? addr.toLowerCase() : "");

  if (normalize(quote.receiver) !== normalize(expected.receiver)) {
    throw new Error(`CoW quote receiver mismatch: expected ${expected.receiver}, got ${String(quote.receiver)}`);
  }
  if (normalize(quote.sellToken) !== normalize(expected.sellToken)) {
    throw new Error(`CoW quote sellToken mismatch: expected ${expected.sellToken}, got ${String(quote.sellToken)}`);
  }
  if (normalize(quote.buyToken) !== normalize(expected.buyToken)) {
    throw new Error(`CoW quote buyToken mismatch: expected ${expected.buyToken}, got ${String(quote.buyToken)}`);
  }
  if (String(quote.sellAmount) !== expected.sellAmount.toString()) {
    throw new Error(`CoW quote sellAmount mismatch: expected ${expected.sellAmount.toString()}, got ${String(quote.sellAmount)}`);
  }
  if (quote.kind !== OrderQuoteSideKindSell.SELL && quote.kind !== "sell") {
    throw new Error(`CoW quote kind mismatch: expected ${OrderQuoteSideKindSell.SELL}, got ${String(quote.kind)}`);
  }
}

/**
 * Alias for assertQuoteMatchesRequest to support alternative naming conventions.
 */
export const assertQuoteBinding = assertQuoteMatchesRequest;

/**
 * Supported chain IDs for automated CoW Swap cash-out.
 * Currently restricted strictly to Gnosis Chain (100) where UUSD is deployed and verified.
 */
export const COWSWAP_CASHOUT_SUPPORTED_CHAIN_IDS: readonly number[] = [100];

/**
 * Checks whether CoW Swap cash-out is supported for a given chain ID.
 *
 * @param chainId - Blockchain network chain ID
 * @returns true if cash-out is supported, false otherwise
 */
export function isCowSwapCashoutSupported(chainId: number | undefined): boolean {
  if (!chainId) return false;
  return COWSWAP_CASHOUT_SUPPORTED_CHAIN_IDS.includes(chainId);
}

/**
 * CoW SDK expects a specific chain id enum type. Validate at runtime to avoid silently targeting the wrong endpoint.
 *
 * @param chainId - The chain ID to validate.
 * @returns The chain ID cast as SupportedChainId.
 * @throws Error if the chain ID is not supported by CoW Protocol.
 */
function asSupportedChainId(chainId: number): SupportedChainId {
  const supported = Object.values(SupportedChainId).filter((v): v is number => typeof v === "number");
  if (!supported.includes(chainId)) {
    throw new Error(`Unsupported CoW Protocol chainId: ${chainId}`);
  }
  return chainId as SupportedChainId;
}

/**
 * Returns CoW Protocol vault relayer address for a given chain.
 * This is the spender that must be approved for ERC20 sell tokens.
 *
 * @param chainId - The blockchain network chain ID.
 * @returns The CoW Protocol vault relayer address.
 * @throws Error if the chain ID is not supported.
 */
export function getCowSwapVaultRelayerAddress(chainId: number): Address {
  const addr = (COW_PROTOCOL_VAULT_RELAYER_ADDRESS as Record<number, Address>)[chainId];
  if (!addr) throw new Error(`Unsupported chainId for CoW vault relayer: ${chainId}`);
  return addr;
}

/**
 * Returns partner fee bps for a given chain and output token (if applicable).
 * Partner fee is disabled for UUSD output to avoid reducing the settlement token.
 */
/**
 * Calculates the partner fee in basis points for a given chain and output token.
 * Partner fee is waived when the output token is UUSD to prevent reducing base rewards.
 *
 * @param chainId - The EVM chain identifier.
 * @param tokenOut - The destination token contract address.
 * @returns The fee in basis points (e.g. 10 bps) or undefined if no fee applies.
 */
function getPartnerFeeBps(chainId: number, tokenOut: Address): number | undefined {
  const info = getTokenInfo(chainId, tokenOut);
  if (!info) return undefined;
  // Apply partner fee to all swaps where the output token is NOT UUSD.
  return info.symbol.toUpperCase() === "UUSD" ? undefined : COWSWAP_PARTNER_FEE_BPS;
}

/**
 * Builds the AppData JSON string and corresponding Keccak-256 hash required for CoW Protocol orders.
 *
 * @param partnerFeeBps - Optional partner fee basis points to encode into the metadata.
 * @returns An object containing fullAppData JSON string and appDataKeccak256 hash.
 */
async function buildCowAppDataInfo(partnerFeeBps: number | undefined) {
  return await buildAppData({
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    appCode: "pay.ubq.fi",
    orderClass: "market",
    ...(partnerFeeBps !== undefined ? { partnerFee: { bps: partnerFeeBps, recipient: COWSWAP_PARTNER_FEE_RECIPIENT } } : {}),
  });
}

/**
 * Fetches a quote from the CowSwap API for a potential swap.
 * Does not require signing or submit an order.
 *
 * @param params - Configuration parameters for the quote query.
 * @returns The estimated output amount, fees, and costs breakdown.
 */
export async function getCowSwapQuote(params: CowSwapQuoteParams): Promise<CowSwapQuoteResult> {
  if (!params.chainId) {
    throw new Error("Chain ID is required to get CowSwap quote.");
  }

  const tokenInInfo = getTokenInfo(params.chainId, params.tokenIn);
  const tokenOutInfo = getTokenInfo(params.chainId, params.tokenOut);

  if (!tokenInInfo || !tokenOutInfo) {
    throw new Error(`Cannot find token info for ${params.tokenIn} or ${params.tokenOut} on chain ${params.chainId}`);
  }

  const partnerFeeBps = getPartnerFeeBps(params.chainId, params.tokenOut);
  const appDataInfo = await buildCowAppDataInfo(partnerFeeBps);

  const chainId = asSupportedChainId(params.chainId);
  const orderBookApi = new OrderBookApi({ chainId });
  const quoteResponse = await orderBookApi.getQuote(
    buildCowQuoteRequest({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      from: params.userAddress,
      receiver: params.userAddress,
      amountIn: params.amountIn,
      appDataInfo,
    })
  );

  const amountsAndCosts = getQuoteAmountsAndCosts({
    orderParams: quoteResponse.quote,
    sellDecimals: tokenInInfo.decimals,
    buyDecimals: tokenOutInfo.decimals,
    slippagePercentBps: DEFAULT_SLIPPAGE_BPS,
    partnerFeeBps,
  });

  return {
    estimatedAmountOut: amountsAndCosts.afterSlippage.buyAmount,
    feeAmount: BigInt(quoteResponse.quote.feeAmount),
    amountsAndCosts,
  };
}

/**
 * Post a CoW swap order for `amountIn` of `tokenIn` -> `tokenOut`.
 *
 * Notes:
 * - This only posts the order; settlement depends on liquidity and the owner's token allowance to the CoW vault relayer.
 * - Caller should ensure allowance is sufficient before calling, otherwise the quote/order may fail or remain unfillable.
 *
 * @param params - Order parameters including tokens, amounts, owner, receiver, chain ID, and wallet client.
 * @returns Object containing the submitted orderId string.
 */
export async function postCowSwapOrder(params: CowSwapOrderParams): Promise<{ orderId: string }> {
  const tokenInInfo = getTokenInfo(params.chainId, params.tokenIn);
  const tokenOutInfo = getTokenInfo(params.chainId, params.tokenOut);

  if (!tokenInInfo || !tokenOutInfo) {
    throw new Error(`Cannot find token info for ${params.tokenIn} or ${params.tokenOut} on chain ${params.chainId}`);
  }

  const partnerFeeBps = getPartnerFeeBps(params.chainId, params.tokenOut);
  const appDataInfo = await buildCowAppDataInfo(partnerFeeBps);

  const chainId = asSupportedChainId(params.chainId);
  const orderBookApi = new OrderBookApi({ chainId });
  const quoteResponse = await orderBookApi.getQuote(
    buildCowQuoteRequest({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      from: params.owner,
      receiver: params.receiver,
      amountIn: params.amountIn,
      appDataInfo,
    })
  );

  const rawDomain = await OrderSigningUtils.getDomain(chainId);
  const domain = {
    name: rawDomain.name,
    version: rawDomain.version,
    chainId,
    verifyingContract: rawDomain.verifyingContract as Address,
  };
  const types = OrderSigningUtils.getEIP712Types() as unknown as Record<string, Array<{ name: string; type: string }>>;

  const quote = quoteResponse.quote as unknown as Record<string, unknown>;
  assertQuoteMatchesRequest(quote, {
    receiver: params.receiver,
    sellToken: params.tokenIn,
    buyToken: params.tokenOut,
    sellAmount: params.amountIn,
  });

  // Build the message explicitly from the EIP-712 Order fields to avoid leaking extra fields into the signature.
  const orderFields = (types.Order ?? []).map((t) => t.name);
  const message = Object.fromEntries(orderFields.map((name) => [name, quote[name]])) as Record<string, unknown>;
  const signature = await params.walletClient.signTypedData({
    account: params.owner,
    domain,
    primaryType: "Order",
    types,
    message,
  });

  // Send order with explicit fields to avoid passing unexpected keys to the API.
  type SendOrderParams = Parameters<OrderBookApi["sendOrder"]>[0];

  // If we provide appDataHash alongside appData, CoW requires appData to be the JSON string.
  // Ensure the hash we built from appDataInfo matches the hash that we signed over.
  const signedAppData = (message as Record<string, unknown>)["appData"];
  if (typeof signedAppData === "string" && signedAppData.toLowerCase() !== appDataInfo.appDataKeccak256.toLowerCase()) {
    throw new Error("CoW appData hash mismatch between quote/signature and appDataInfo");
  }

  const orderId = await orderBookApi.sendOrder({
    ...message,
    from: params.owner,
    quoteId: quoteResponse.id ?? null,
    signature,
    signingScheme: SigningScheme.EIP712,
    appData: appDataInfo.fullAppData,
    appDataHash: appDataInfo.appDataKeccak256,
  } as unknown as SendOrderParams);

  return { orderId };
}
