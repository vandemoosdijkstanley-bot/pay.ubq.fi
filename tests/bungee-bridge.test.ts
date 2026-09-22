import { describe, expect, it, mock } from "bun:test";
import {
  isBungeeChainSupported,
  buildBungeeQuoteQueryParams,
  fetchBungeeQuote,
  assertRouteMatchesRequest,
  buildBungeeTransaction,
  getBungeeBridgeStatus,
  type BungeeQuoteParams,
  type BungeeRoute,
} from "../src/utils/bungee-utils.ts";

describe("Bungee Exchange REST API Cross-Chain Bridge Integration (#446)", () => {
  const mockUser = "0x1111111111111111111111111111111111111111" as const;
  const mockReceiver = "0x2222222222222222222222222222222222222222" as const;
  const mockTokenGno = "0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6" as const; // GNO
  const mockTokenUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // Base USDC

  describe("1. Chain Support & Parameter Invariants", () => {
    it("should accept supported EVM networks (Gnosis 100, Base 8453, Mainnet 1, Arbitrum 42161)", () => {
      expect(isBungeeChainSupported(100)).toBe(true);
      expect(isBungeeChainSupported(8453)).toBe(true);
      expect(isBungeeChainSupported(1)).toBe(true);
      expect(isBungeeChainSupported(42161)).toBe(true);
      expect(isBungeeChainSupported(10)).toBe(true);
      expect(isBungeeChainSupported(137)).toBe(true);
    });

    it("should reject unsupported chain IDs", () => {
      expect(isBungeeChainSupported(999999)).toBe(false);
      expect(isBungeeChainSupported(0)).toBe(false);
    });

    it("should correctly build query parameters for valid requests", () => {
      const params: BungeeQuoteParams = {
        fromChainId: 100,
        toChainId: 8453,
        fromTokenAddress: mockTokenGno,
        toTokenAddress: mockTokenUsdc,
        fromAmount: 1000000000000000000n, // 1 GNO
        userAddress: mockUser,
        recipient: mockReceiver,
      };

      const queryStr = buildBungeeQuoteQueryParams(params);
      expect(queryStr).toContain("fromChainId=100");
      expect(queryStr).toContain("toChainId=8453");
      expect(queryStr).toContain(`fromTokenAddress=${mockTokenGno}`);
      expect(queryStr).toContain(`toTokenAddress=${mockTokenUsdc}`);
      expect(queryStr).toContain("fromAmount=1000000000000000000");
      expect(queryStr).toContain(`userAddress=${mockUser}`);
      expect(queryStr).toContain(`recipient=${mockReceiver}`);
      expect(queryStr).toContain("singleTxOnly=true");
    });

    it("should throw if fromAmount <= 0", () => {
      const params: BungeeQuoteParams = {
        fromChainId: 100,
        toChainId: 8453,
        fromTokenAddress: mockTokenGno,
        toTokenAddress: mockTokenUsdc,
        fromAmount: 0n,
        userAddress: mockUser,
      };

      expect(() => buildBungeeQuoteQueryParams(params)).toThrow("fromAmount must be greater than zero");
    });
  });

  describe("2. REST API Quote Retrieval", () => {
    it("should parse Bungee quote response and extract optimal route", async () => {
      const mockApiResponse = {
        success: true,
        result: {
          routes: [
            {
              routeId: "route-12345",
              isOnlySwap: false,
              fromAmount: "1000000000000000000",
              toAmount: "285000000", // 285 USDC
              usedBridgeNames: ["across", "stargate"],
              totalGasFeesInUsd: 0.45,
              serviceTime: 120,
              sender: mockUser,
              recipient: mockReceiver,
              totalUserTx: 1,
            },
          ],
        },
      };

      const mockFetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => mockApiResponse,
      })) as unknown as typeof fetch;

      const params: BungeeQuoteParams = {
        fromChainId: 100,
        toChainId: 8453,
        fromTokenAddress: mockTokenGno,
        toTokenAddress: mockTokenUsdc,
        fromAmount: 1000000000000000000n,
        userAddress: mockUser,
        recipient: mockReceiver,
      };

      const result = await fetchBungeeQuote(params, mockFetch);
      expect(result.success).toBe(true);
      expect(result.routes.length).toBe(1);
      expect(result.selectedRoute?.routeId).toBe("route-12345");
      expect(result.selectedRoute?.toAmount).toBe("285000000");
      expect(result.selectedRoute?.usedBridgeNames).toEqual(["across", "stargate"]);
      expect(result.selectedRoute?.totalGasFeesInUsd).toBe(0.45);
    });

    it("should handle empty routes gracefully", async () => {
      const mockFetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { routes: [] } }),
      })) as unknown as typeof fetch;

      const params: BungeeQuoteParams = {
        fromChainId: 100,
        toChainId: 8453,
        fromTokenAddress: mockTokenGno,
        toTokenAddress: mockTokenUsdc,
        fromAmount: 1000000000000000000n,
        userAddress: mockUser,
      };

      const result = await fetchBungeeQuote(params, mockFetch);
      expect(result.success).toBe(false);
      expect(result.routes.length).toBe(0);
      expect(result.selectedRoute).toBeUndefined();
    });
  });

  describe("3. Security Invariant Verification", () => {
    it("should pass assertRouteMatchesRequest when route perfectly conforms to request", () => {
      const route: BungeeRoute = {
        routeId: "route-valid",
        isOnlySwap: false,
        fromAmount: "1000000000000000000",
        toAmount: "285000000",
        usedBridgeNames: ["across"],
        totalGasFeesInUsd: 0.35,
        serviceTime: 90,
        sender: mockUser,
        recipient: mockReceiver,
        totalUserTx: 1,
      };

      const params: BungeeQuoteParams = {
        fromChainId: 100,
        toChainId: 8453,
        fromTokenAddress: mockTokenGno,
        toTokenAddress: mockTokenUsdc,
        fromAmount: 1000000000000000000n,
        userAddress: mockUser,
        recipient: mockReceiver,
      };

      expect(() => assertRouteMatchesRequest(route, params)).not.toThrow();
    });

    it("should fail assertRouteMatchesRequest if recipient was tampered (CWE-345 protection)", () => {
      const maliciousRoute: BungeeRoute = {
        routeId: "route-tampered",
        isOnlySwap: false,
        fromAmount: "1000000000000000000",
        toAmount: "285000000",
        usedBridgeNames: ["across"],
        totalGasFeesInUsd: 0.35,
        serviceTime: 90,
        sender: mockUser,
        recipient: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as const, // Tampered!
        totalUserTx: 1,
      };

      const params: BungeeQuoteParams = {
        fromChainId: 100,
        toChainId: 8453,
        fromTokenAddress: mockTokenGno,
        toTokenAddress: mockTokenUsdc,
        fromAmount: 1000000000000000000n,
        userAddress: mockUser,
        recipient: mockReceiver,
      };

      expect(() => assertRouteMatchesRequest(maliciousRoute, params)).toThrow(
        "Security Invariant Violated: Bungee route recipient"
      );
    });

    it("should fail assertRouteMatchesRequest if output amount is zero", () => {
      const zeroOutputRoute: BungeeRoute = {
        routeId: "route-zero",
        isOnlySwap: false,
        fromAmount: "1000000000000000000",
        toAmount: "0",
        usedBridgeNames: ["across"],
        totalGasFeesInUsd: 0.35,
        serviceTime: 90,
        sender: mockUser,
        recipient: mockReceiver,
        totalUserTx: 1,
      };

      const params: BungeeQuoteParams = {
        fromChainId: 100,
        toChainId: 8453,
        fromTokenAddress: mockTokenGno,
        toTokenAddress: mockTokenUsdc,
        fromAmount: 1000000000000000000n,
        userAddress: mockUser,
        recipient: mockReceiver,
      };

      expect(() => assertRouteMatchesRequest(zeroOutputRoute, params)).toThrow(
        "Security Invariant Violated: Route output amount must be strictly greater than zero"
      );
    });
  });

  describe("4. Build-TX & Bridge Status Execution", () => {
    it("should build execution calldata and approval data from selected route", async () => {
      const mockBuildResponse = {
        success: true,
        result: {
          approvalData: {
            minimumApprovalAmount: "1000000000000000000",
            allowanceTarget: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5",
            owner: mockUser,
            tokenAddress: mockTokenGno,
          },
          txData: "0xabcdef123456",
          to: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5",
          value: "0",
          chainId: 100,
        },
      };

      const mockFetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => mockBuildResponse,
      })) as unknown as typeof fetch;

      const route: BungeeRoute = {
        routeId: "route-12345",
        isOnlySwap: false,
        fromAmount: "1000000000000000000",
        toAmount: "285000000",
        usedBridgeNames: ["across"],
        totalGasFeesInUsd: 0.45,
        serviceTime: 120,
        sender: mockUser,
        recipient: mockReceiver,
        totalUserTx: 1,
      };

      const txResult = await buildBungeeTransaction(route, mockFetch);
      expect(txResult.success).toBe(true);
      expect(txResult.txData).toBe("0xabcdef123456");
      expect(txResult.to).toBe("0x3a23F943181408EAC424116Af7b7790c94Cb97a5");
      expect(txResult.approvalData?.minimumApprovalAmount).toBe("1000000000000000000");
      expect(txResult.chainId).toBe(100);
    });

    it("should poll bridge status correctly", async () => {
      const mockStatusResponse = {
        success: true,
        result: {
          sourceTxStatus: "COMPLETED",
          destinationTxStatus: "COMPLETED",
          sourceTxHash: "0xsource111",
          destinationTxHash: "0xdestination222",
        },
      };

      const mockFetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => mockStatusResponse,
      })) as unknown as typeof fetch;

      const status = await getBungeeBridgeStatus("0xsource111", 100, 8453, mockFetch);
      expect(status.isComplete).toBe(true);
      expect(status.sourceTxStatus).toBe("COMPLETED");
      expect(status.destinationTxStatus).toBe("COMPLETED");
      expect(status.destinationTxHash).toBe("0xdestination222");
    });
  });
});
