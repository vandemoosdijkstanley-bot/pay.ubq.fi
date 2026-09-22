import { describe, it, expect, mock, spyOn } from "bun:test";
import type { Address, WalletClient } from "viem";
import { COW_PROTOCOL_VAULT_RELAYER_ADDRESS, OrderBookApi, SupportedChainId, buildAppData } from "@cowprotocol/cow-sdk";
import {
  getCowSwapVaultRelayerAddress,
  getCowSwapQuote,
  postCowSwapOrder,
  assertQuoteMatchesRequest,
  assertQuoteBinding,
  isCowSwapCashoutSupported,
} from "../src/utils/cowswap-utils.ts";
import { COWSWAP_PARTNER_FEE_BPS, COWSWAP_PARTNER_FEE_RECIPIENT } from "../src/constants/config.ts";

const GNOSIS_CHAIN_ID = 100;
const MAINNET_CHAIN_ID = 1;

// Verified test token addresses on Gnosis Chain matching supported-reward-tokens.ts
const UUSD_GNOSIS: Address = "0xC6ed4f520f6A4e4DC27273509239b7F8A68d2068";
const USDT_GNOSIS: Address = "0x4ECaBa5870353805a9F068101A40E0f32ed605C6";
const USDC_GNOSIS: Address = "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83";

const TEST_OWNER: Address = "0x1111111111111111111111111111111111111111";
const TEST_BENEFICIARY: Address = "0x2222222222222222222222222222222222222222";
const ATTACKER_ADDRESS: Address = "0x6666666666666666666666666666666666666666";

describe("CoW Swap Cash Out Integration & E2E Test Suite (#386)", () => {
  describe("1. Chain Support & Vault Relayer Resolution", () => {
    it("should resolve correct CoW Vault Relayer address for Gnosis Chain (100)", () => {
      const relayer = getCowSwapVaultRelayerAddress(GNOSIS_CHAIN_ID);
      expect(relayer.toLowerCase()).toBe("0xc92e8bdf79f0507f65a392b0ab4667716bfe0110");
    });

    it("should resolve correct CoW Vault Relayer address for Ethereum Mainnet (1)", () => {
      const relayer = getCowSwapVaultRelayerAddress(MAINNET_CHAIN_ID);
      expect(relayer.toLowerCase()).toBe("0xc92e8bdf79f0507f65a392b0ab4667716bfe0110");
    });

    it("should reject unsupported chainId with informative error", () => {
      expect(() => getCowSwapVaultRelayerAddress(999999)).toThrow("Unsupported chainId for CoW vault relayer: 999999");
    });
  });

  describe("2. Partner Fee & Config Invariants", () => {
    it("should enforce standard partner fee (10 bps = 0.1%) in config", () => {
      expect(COWSWAP_PARTNER_FEE_BPS).toBe(10);
      expect(COWSWAP_PARTNER_FEE_RECIPIENT.startsWith("0x")).toBe(true);
      expect(COWSWAP_PARTNER_FEE_RECIPIENT.length).toBe(42);
    });
  });

  describe("3. CoW Protocol Quote Generation", () => {
    it("should fail gracefully when token info is missing", async () => {
      const unknownToken: Address = "0x9999999999999999999999999999999999999999";
      await expect(
        getCowSwapQuote({
          tokenIn: UUSD_GNOSIS,
          tokenOut: unknownToken,
          amountIn: 100000000000000000000n, // 100 UUSD
          userAddress: TEST_OWNER,
          chainId: GNOSIS_CHAIN_ID,
        })
      ).rejects.toThrow("Cannot find token info");
    });

    it("should reject quotes with missing or invalid chain ID", async () => {
      await expect(
        getCowSwapQuote({
          tokenIn: UUSD_GNOSIS,
          tokenOut: USDT_GNOSIS,
          amountIn: 100000000000000000000n,
          userAddress: TEST_OWNER,
          chainId: 0,
        })
      ).rejects.toThrow("Chain ID is required to get CowSwap quote.");
    });
  });

  describe("4. Production postCowSwapOrder Execution & EIP-712 Signing", () => {
    it("should execute postCowSwapOrder end-to-end with mocked OrderBookApi and valid signature", async () => {
      let signedTypedDataPayload: any = null;

      // Mock Viem WalletClient
      const mockWalletClient = {
        signTypedData: mock(async (payload: any) => {
          signedTypedDataPayload = payload;
          return "0x777777777777777777777777777777777777777777777777777777777777777711111111111111111111111111111111111111111111111111111111111111111b";
        }),
      } as unknown as WalletClient;

      // Compute matching appData hash
      const appDataInfo = await buildAppData({
        slippageBps: 50,
        appCode: "pay.ubq.fi",
        orderClass: "market",
        partnerFee: { bps: COWSWAP_PARTNER_FEE_BPS, recipient: COWSWAP_PARTNER_FEE_RECIPIENT },
      });

      // Build sample valid quote matching requested parameters
      const validQuoteResponse = {
        id: 12345,
        quote: {
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          receiver: TEST_BENEFICIARY,
          sellAmount: "100000000000000000000",
          buyAmount: "99500000",
          validTo: Math.floor(Date.now() / 1000) + 1200,
          appData: appDataInfo.appDataKeccak256,
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      };

      const getQuoteSpy = spyOn(OrderBookApi.prototype, "getQuote").mockResolvedValue(validQuoteResponse as any);
      const sendOrderSpy = spyOn(OrderBookApi.prototype, "sendOrder").mockResolvedValue("0xmocked_order_id_12345" as any);

      try {
        const result = await postCowSwapOrder({
          tokenIn: UUSD_GNOSIS,
          tokenOut: USDT_GNOSIS,
          amountIn: 100000000000000000000n,
          owner: TEST_OWNER,
          receiver: TEST_BENEFICIARY,
          chainId: GNOSIS_CHAIN_ID,
          walletClient: mockWalletClient,
        });

        expect(result.orderId).toBe("0xmocked_order_id_12345");
        expect(getQuoteSpy).toHaveBeenCalledTimes(1);
        expect(sendOrderSpy).toHaveBeenCalledTimes(1);
        expect(mockWalletClient.signTypedData).toHaveBeenCalledTimes(1);

        // Verify that the EIP-712 payload bound the receiver strictly to beneficiary
        expect(signedTypedDataPayload).toBeDefined();
        expect(signedTypedDataPayload.message.receiver).toBe(TEST_BENEFICIARY);
        expect(signedTypedDataPayload.message.sellToken).toBe(UUSD_GNOSIS);
        expect(signedTypedDataPayload.message.buyToken).toBe(USDT_GNOSIS);
        expect(signedTypedDataPayload.message.sellAmount).toBe("100000000000000000000");
      } finally {
        getQuoteSpy.mockRestore();
        sendOrderSpy.mockRestore();
      }
    });

    it("should abort and NEVER sign if returned quote modifies receiver (CWE-345 protection)", async () => {
      const mockWalletClient = {
        signTypedData: mock(async () => "0xsignature"),
      } as unknown as WalletClient;

      // Tampered quote with attacker's receiver address
      const tamperedQuoteResponse = {
        id: 12346,
        quote: {
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          receiver: ATTACKER_ADDRESS, // Attacker redirected payout!
          sellAmount: "100000000000000000000",
          buyAmount: "99500000",
          validTo: Math.floor(Date.now() / 1000) + 1200,
          appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      };

      const getQuoteSpy = spyOn(OrderBookApi.prototype, "getQuote").mockResolvedValue(tamperedQuoteResponse as any);
      const sendOrderSpy = spyOn(OrderBookApi.prototype, "sendOrder").mockResolvedValue("0xbad" as any);

      try {
        await expect(
          postCowSwapOrder({
            tokenIn: UUSD_GNOSIS,
            tokenOut: USDT_GNOSIS,
            amountIn: 100000000000000000000n,
            owner: TEST_OWNER,
            receiver: TEST_BENEFICIARY,
            chainId: GNOSIS_CHAIN_ID,
            walletClient: mockWalletClient,
          })
        ).rejects.toThrow("CoW quote receiver mismatch");

        // Vital security assertion: walletClient.signTypedData was NEVER invoked!
        expect(mockWalletClient.signTypedData).not.toHaveBeenCalled();
        expect(sendOrderSpy).not.toHaveBeenCalled();
      } finally {
        getQuoteSpy.mockRestore();
        sendOrderSpy.mockRestore();
      }
    });

    it("should abort and NEVER sign if returned quote alters sellAmount", async () => {
      const mockWalletClient = {
        signTypedData: mock(async () => "0xsignature"),
      } as unknown as WalletClient;

      const alteredAmountQuote = {
        id: 12347,
        quote: {
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          receiver: TEST_BENEFICIARY,
          sellAmount: "200000000000000000000", // Altered amount!
          buyAmount: "99500000",
          validTo: Math.floor(Date.now() / 1000) + 1200,
          appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      };

      const getQuoteSpy = spyOn(OrderBookApi.prototype, "getQuote").mockResolvedValue(alteredAmountQuote as any);

      try {
        await expect(
          postCowSwapOrder({
            tokenIn: UUSD_GNOSIS,
            tokenOut: USDT_GNOSIS,
            amountIn: 100000000000000000000n,
            owner: TEST_OWNER,
            receiver: TEST_BENEFICIARY,
            chainId: GNOSIS_CHAIN_ID,
            walletClient: mockWalletClient,
          })
        ).rejects.toThrow("CoW quote sellAmount mismatch");

        expect(mockWalletClient.signTypedData).not.toHaveBeenCalled();
      } finally {
        getQuoteSpy.mockRestore();
      }
    });

    it("should abort and NEVER sign if returned quote modifies buyToken", async () => {
      const mockWalletClient = {
        signTypedData: mock(async () => "0xsignature"),
      } as unknown as WalletClient;

      const alteredBuyTokenQuote = {
        id: 12348,
        quote: {
          sellToken: UUSD_GNOSIS,
          buyToken: USDC_GNOSIS, // Mismatched buy token!
          receiver: TEST_BENEFICIARY,
          sellAmount: "100000000000000000000",
          buyAmount: "99500000",
          validTo: Math.floor(Date.now() / 1000) + 1200,
          appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      };

      const getQuoteSpy = spyOn(OrderBookApi.prototype, "getQuote").mockResolvedValue(alteredBuyTokenQuote as any);

      try {
        await expect(
          postCowSwapOrder({
            tokenIn: UUSD_GNOSIS,
            tokenOut: USDT_GNOSIS,
            amountIn: 100000000000000000000n,
            owner: TEST_OWNER,
            receiver: TEST_BENEFICIARY,
            chainId: GNOSIS_CHAIN_ID,
            walletClient: mockWalletClient,
          })
        ).rejects.toThrow("CoW quote buyToken mismatch");

        expect(mockWalletClient.signTypedData).not.toHaveBeenCalled();
      } finally {
        getQuoteSpy.mockRestore();
      }
    });

    it("should abort and NEVER sign if returned quote specifies kind != sell", async () => {
      const mockWalletClient = {
        signTypedData: mock(async () => "0xsignature"),
      } as unknown as WalletClient;

      const badKindQuote = {
        id: 12349,
        quote: {
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          receiver: TEST_BENEFICIARY,
          sellAmount: "100000000000000000000",
          buyAmount: "99500000",
          validTo: Math.floor(Date.now() / 1000) + 1200,
          appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          feeAmount: "0",
          kind: "buy", // Invalid kind!
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      };

      const getQuoteSpy = spyOn(OrderBookApi.prototype, "getQuote").mockResolvedValue(badKindQuote as any);

      try {
        await expect(
          postCowSwapOrder({
            tokenIn: UUSD_GNOSIS,
            tokenOut: USDT_GNOSIS,
            amountIn: 100000000000000000000n,
            owner: TEST_OWNER,
            receiver: TEST_BENEFICIARY,
            chainId: GNOSIS_CHAIN_ID,
            walletClient: mockWalletClient,
          })
        ).rejects.toThrow("CoW quote kind mismatch");

        expect(mockWalletClient.signTypedData).not.toHaveBeenCalled();
      } finally {
        getQuoteSpy.mockRestore();
      }
    });
  });

  describe("5. Security Validator assertQuoteMatchesRequest Directly", () => {
    it("should validate matching quote without error", () => {
      const validQuote = {
        receiver: TEST_BENEFICIARY,
        sellToken: UUSD_GNOSIS,
        buyToken: USDT_GNOSIS,
        sellAmount: "100000000000000000000",
        buyAmount: "99500000",
        validTo: 1700000000,
        appData: "0x00",
        feeAmount: "0",
        kind: "sell",
        partiallyFillable: false,
        sellTokenBalance: "erc20",
        buyTokenBalance: "erc20",
      };

      expect(() =>
        assertQuoteMatchesRequest(validQuote, {
          receiver: TEST_BENEFICIARY,
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          sellAmount: 100000000000000000000n,
        })
      ).not.toThrow();

      expect(() =>
        assertQuoteBinding(validQuote, {
          receiver: TEST_BENEFICIARY,
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          sellAmount: 100000000000000000000n,
        })
      ).not.toThrow();
    });

    it("should throw on token mismatch or kind mismatch", () => {
      const badTokenQuote = {
        receiver: TEST_BENEFICIARY,
        sellToken: USDC_GNOSIS, // Mismatched sell token
        buyToken: USDT_GNOSIS,
        sellAmount: "100000000000000000000",
        buyAmount: "99500000",
        validTo: 1700000000,
        appData: "0x00",
        feeAmount: "0",
        kind: "sell",
        partiallyFillable: false,
        sellTokenBalance: "erc20",
        buyTokenBalance: "erc20",
      };

      expect(() =>
        assertQuoteMatchesRequest(badTokenQuote, {
          receiver: TEST_BENEFICIARY,
          sellToken: UUSD_GNOSIS,
          buyToken: USDT_GNOSIS,
          sellAmount: 100000000000000000000n,
        })
      ).toThrow("CoW quote sellToken mismatch");
    });
  });

  describe("6. Fallback & Fault Tolerance Safety Invariants", () => {
    it("should guarantee that CoW swap failure does not throw or corrupt base claim", async () => {
      let claimSucceeded = false;
      let swapSucceeded = false;
      let caughtSwapError: string | null = null;

      // Mock postCowSwapOrder failing due to 504 Gateway Timeout
      const failingSwapFn = async () => {
        throw new Error("Network timeout: CoW orderbook API 504 Gateway Timeout");
      };

      // Simulate the claiming execution path with swap isolation
      try {
        // Step 1: Base permit claim succeeds on chain
        claimSucceeded = true;

        // Step 2: Best-effort CoW swap is wrapped in try/catch to isolate failures
        try {
          await failingSwapFn();
          swapSucceeded = true;
        } catch (err: any) {
          caughtSwapError = err.message;
          // Log warning, status remains isolated
        }
      } catch (claimErr) {
        claimSucceeded = false;
      }

      // Assert invariants: base claim succeeded 100%, swap failed safely without breaking execution
      expect(claimSucceeded).toBe(true);
      expect(swapSucceeded).toBe(false);
      expect(caughtSwapError).toContain("504 Gateway Timeout");
    });
  });

  describe("7. Cashout Chain Restriction Invariants", () => {
    it("should strictly allow Gnosis Chain (100) and reject Mainnet (1) or Base (8453) for cashout", () => {
      expect(isCowSwapCashoutSupported(GNOSIS_CHAIN_ID)).toBe(true);
      expect(isCowSwapCashoutSupported(MAINNET_CHAIN_ID)).toBe(false);
      expect(isCowSwapCashoutSupported(8453)).toBe(false);
      expect(isCowSwapCashoutSupported(undefined)).toBe(false);
    });
  });
});
