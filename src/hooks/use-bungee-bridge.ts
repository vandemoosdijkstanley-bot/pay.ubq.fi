import { useCallback, useState } from "react";
import type { Address, WalletClient } from "viem";
import {
  fetchBungeeQuote,
  buildBungeeTransaction,
  assertRouteMatchesRequest,
  getBungeeBridgeStatus,
  type BungeeQuoteParams,
  type BungeeRoute,
  type BungeeBridgeStatusResult,
} from "../utils/bungee-utils.ts";

export interface UseBungeeBridgeState {
  isQuoting: boolean;
  isBuilding: boolean;
  isExecuting: boolean;
  isPolling: boolean;
  error: string | null;
  routes: BungeeRoute[];
  selectedRoute: BungeeRoute | null;
  bridgeStatus: BungeeBridgeStatusResult | null;
}

export function useBungeeBridge(walletClient: WalletClient | null, userAddress: Address | undefined) {
  const [state, setState] = useState<UseBungeeBridgeState>({
    isQuoting: false,
    isBuilding: false,
    isExecuting: false,
    isPolling: false,
    error: null,
    routes: [],
    selectedRoute: null,
    bridgeStatus: null,
  });

  const getQuote = useCallback(
    async (params: Omit<BungeeQuoteParams, "userAddress">) => {
      if (!userAddress) {
        setState((s) => ({ ...s, error: "Wallet not connected" }));
        return null;
      }

      setState((s) => ({ ...s, isQuoting: true, error: null }));
      try {
        const fullParams: BungeeQuoteParams = {
          ...params,
          userAddress,
        };
        const quoteRes = await fetchBungeeQuote(fullParams);
        setState((s) => ({
          ...s,
          isQuoting: false,
          routes: quoteRes.routes,
          selectedRoute: quoteRes.selectedRoute || null,
        }));
        return quoteRes;
      } catch (err: any) {
        setState((s) => ({
          ...s,
          isQuoting: false,
          error: err.message || "Failed to fetch Bungee quote",
        }));
        return null;
      }
    },
    [userAddress]
  );

  const executeBridge = useCallback(
    async (route: BungeeRoute, fromToken: Address, fromChainId: number, toChainId: number) => {
      if (!walletClient || !userAddress) {
        setState((s) => ({ ...s, error: "Wallet not connected for execution" }));
        return null;
      }

      setState((s) => ({ ...s, isBuilding: true, error: null }));
      try {
        assertRouteMatchesRequest(route, {
          fromChainId,
          toChainId,
          fromTokenAddress: fromToken,
          toTokenAddress: fromToken, // or target token
          fromAmount: BigInt(route.fromAmount),
          userAddress,
          recipient: route.recipient,
        });

        const txPayload = await buildBungeeTransaction(route);
        setState((s) => ({ ...s, isBuilding: false, isExecuting: true }));

        const hash = await walletClient.sendTransaction({
          to: txPayload.to,
          data: txPayload.txData,
          value: BigInt(txPayload.value),
          account: userAddress,
          chain: walletClient.chain,
        });

        setState((s) => ({ ...s, isExecuting: false, isPolling: true }));

        const status = await getBungeeBridgeStatus(hash, fromChainId, toChainId);
        setState((s) => ({ ...s, isPolling: false, bridgeStatus: status }));

        return hash;
      } catch (err: any) {
        setState((s) => ({
          ...s,
          isBuilding: false,
          isExecuting: false,
          error: err.message || "Bridge execution failed",
        }));
        return null;
      }
    },
    [walletClient, userAddress]
  );

  return {
    ...state,
    getQuote,
    executeBridge,
  };
}
