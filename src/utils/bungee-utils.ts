import type { Address } from "viem";

/**
 * Socket / Bungee API v2 base endpoints.
 */
export const BUNGEE_API_BASE_URL = "https://api.socket.tech/v2";
export const DEFAULT_SOCKET_API_KEY = "72a5b4b0-e70e-48d0-b7e3-e52e25bed0d8"; // Public Socket Integrator Key

/**
 * Supported chain IDs for Bungee bridge & cross-chain settlements.
 */
export const SUPPORTED_BUNGEE_CHAINS: ReadonlyArray<number> = [
  1,     // Ethereum Mainnet
  10,    // Optimism
  100,   // Gnosis Chain
  137,   // Polygon PoS
  8453,  // Base L2
  42161, // Arbitrum One
];

export interface BungeeQuoteParams {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: Address;
  toTokenAddress: Address;
  fromAmount: bigint;
  userAddress: Address;
  recipient?: Address;
  singleTxOnly?: boolean;
  sort?: "output" | "gas" | "time";
  uniqueRoutesPerBridge?: boolean;
}

export interface BungeeBridgeFee {
  amount: string;
  feesInUsd: number;
  asset: {
    symbol: string;
    decimals: number;
    address: Address;
  };
}

export interface BungeeRoute {
  routeId: string;
  isOnlySwap: boolean;
  fromAmount: string;
  toAmount: string;
  usedBridgeNames: string[];
  totalGasFeesInUsd: number;
  serviceTime: number;
  sender: Address;
  recipient: Address;
  totalUserTx: number;
  extraData?: Record<string, unknown>;
}

export interface BungeeQuoteResult {
  success: boolean;
  routes: BungeeRoute[];
  selectedRoute?: BungeeRoute;
  rawResponse?: unknown;
}

export interface BungeeApprovalData {
  minimumApprovalAmount: string;
  allowanceTarget: Address;
  owner: Address;
  tokenAddress: Address;
}

export interface BungeeBuildTxResult {
  success: boolean;
  approvalData?: BungeeApprovalData;
  txData: `0x${string}`;
  to: Address;
  value: string;
  chainId: number;
}

export interface BungeeBridgeStatusResult {
  isComplete: boolean;
  sourceTxStatus: "PENDING" | "COMPLETED" | "FAILED";
  destinationTxStatus?: "PENDING" | "COMPLETED" | "FAILED";
  sourceTxHash?: string;
  destinationTxHash?: string;
}

/**
 * Validates whether a chainId is supported by Bungee aggregator.
 */
export function isBungeeChainSupported(chainId: number): boolean {
  return SUPPORTED_BUNGEE_CHAINS.includes(chainId);
}

/**
 * Builds the URL query parameters for Bungee /quote endpoint.
 */
export function buildBungeeQuoteQueryParams(params: BungeeQuoteParams, apiKey: string = DEFAULT_SOCKET_API_KEY): string {
  if (!isBungeeChainSupported(params.fromChainId)) {
    throw new Error(`Unsupported source chain ID: ${params.fromChainId}`);
  }
  if (!isBungeeChainSupported(params.toChainId)) {
    throw new Error(`Unsupported destination chain ID: ${params.toChainId}`);
  }
  if (params.fromAmount <= 0n) {
    throw new Error("fromAmount must be greater than zero");
  }

  const query = new URLSearchParams({
    fromChainId: params.fromChainId.toString(),
    toChainId: params.toChainId.toString(),
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    fromAmount: params.fromAmount.toString(),
    userAddress: params.userAddress,
    recipient: params.recipient || params.userAddress,
    singleTxOnly: params.singleTxOnly !== false ? "true" : "false",
    sort: params.sort || "output",
    uniqueRoutesPerBridge: params.uniqueRoutesPerBridge !== false ? "true" : "false",
  });

  return query.toString();
}

/**
 * Fetches optimal cross-chain or same-chain route quotes from Bungee / Socket REST API.
 */
export async function fetchBungeeQuote(
  params: BungeeQuoteParams,
  fetchFn: typeof fetch = fetch,
  apiKey: string = DEFAULT_SOCKET_API_KEY,
): Promise<BungeeQuoteResult> {
  const queryStr = buildBungeeQuoteQueryParams(params, apiKey);
  const endpoint = `${BUNGEE_API_BASE_URL}/quote?${queryStr}`;

  const response = await fetchFn(endpoint, {
    method: "GET",
    headers: {
      "API-KEY": apiKey,
      "Accept": "application/json",
      "User-Agent": "Ubiquity-Pay-Bungee-Client/1.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown network error");
    throw new Error(`Bungee quote request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const routes: BungeeRoute[] = (data.result?.routes || []).map((r: any) => ({
    routeId: r.routeId || "",
    isOnlySwap: Boolean(r.isOnlySwap),
    fromAmount: r.fromAmount || "0",
    toAmount: r.toAmount || "0",
    usedBridgeNames: Array.isArray(r.usedBridgeNames) ? r.usedBridgeNames : [],
    totalGasFeesInUsd: Number(r.totalGasFeesInUsd || 0),
    serviceTime: Number(r.serviceTime || 0),
    sender: (r.sender || params.userAddress) as Address,
    recipient: (r.recipient || params.recipient || params.userAddress) as Address,
    totalUserTx: Number(r.totalUserTx || 1),
    extraData: r,
  }));

  const selectedRoute = routes.length > 0 ? routes[0] : undefined;

  return {
    success: routes.length > 0,
    routes,
    selectedRoute,
    rawResponse: data,
  };
}

/**
 * Invariant Validator: Guarantees that returned Bungee route matches requested parameters.
 * Prevents man-in-the-middle token, recipient, or excessive slippage modifications.
 */
export function assertRouteMatchesRequest(route: BungeeRoute, params: BungeeQuoteParams): void {
  const expectedRecipient = (params.recipient || params.userAddress).toLowerCase();
  if (route.recipient.toLowerCase() !== expectedRecipient) {
    throw new Error(
      `Security Invariant Violated: Bungee route recipient (${route.recipient}) does not match expected (${expectedRecipient})`
    );
  }

  if (BigInt(route.fromAmount) !== params.fromAmount) {
    throw new Error(
      `Security Invariant Violated: Bungee route fromAmount (${route.fromAmount}) differs from requested (${params.fromAmount})`
    );
  }

  if (BigInt(route.toAmount) <= 0n) {
    throw new Error("Security Invariant Violated: Route output amount must be strictly greater than zero");
  }
}

/**
 * Requests the transaction execution payload from Bungee /build-tx endpoint.
 */
export async function buildBungeeTransaction(
  route: BungeeRoute,
  fetchFn: typeof fetch = fetch,
  apiKey: string = DEFAULT_SOCKET_API_KEY,
): Promise<BungeeBuildTxResult> {
  const endpoint = `${BUNGEE_API_BASE_URL}/build-tx`;

  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "API-KEY": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Ubiquity-Pay-Bungee-Client/1.0",
    },
    body: JSON.stringify({ route: route.extraData || route }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown transaction building error");
    throw new Error(`Bungee build-tx request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const res = data.result;

  if (!res || !res.txData || !res.to) {
    throw new Error("Invalid transaction payload returned from Bungee build-tx API");
  }

  let approvalData: BungeeApprovalData | undefined;
  if (res.approvalData) {
    approvalData = {
      minimumApprovalAmount: res.approvalData.minimumApprovalAmount || "0",
      allowanceTarget: res.approvalData.allowanceTarget as Address,
      owner: res.approvalData.owner as Address,
      tokenAddress: res.approvalData.tokenAddress as Address,
    };
  }

  return {
    success: true,
    approvalData,
    txData: res.txData as `0x${string}`,
    to: res.to as Address,
    value: res.value || "0",
    chainId: Number(res.chainId || 0),
  };
}

/**
 * Polls cross-chain bridging status from Socket / Bungee API.
 */
export async function getBungeeBridgeStatus(
  txHash: string,
  fromChainId: number,
  toChainId: number,
  fetchFn: typeof fetch = fetch,
  apiKey: string = DEFAULT_SOCKET_API_KEY,
): Promise<BungeeBridgeStatusResult> {
  const query = new URLSearchParams({
    transactionHash: txHash,
    fromChainId: fromChainId.toString(),
    toChainId: toChainId.toString(),
  });

  const endpoint = `${BUNGEE_API_BASE_URL}/bridge-status?${query.toString()}`;

  const response = await fetchFn(endpoint, {
    method: "GET",
    headers: {
      "API-KEY": apiKey,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Bridge status query failed (${response.status})`);
  }

  const data = await response.json();
  const res = data.result || {};

  const srcStatus = res.sourceTxStatus || "PENDING";
  const dstStatus = res.destinationTxStatus || "PENDING";
  const isComplete = srcStatus === "COMPLETED" && dstStatus === "COMPLETED";

  return {
    isComplete,
    sourceTxStatus: srcStatus,
    destinationTxStatus: dstStatus,
    sourceTxHash: res.sourceTxHash || txHash,
    destinationTxHash: res.destinationTxHash,
  };
}
