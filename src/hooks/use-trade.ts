import { useCallback } from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import Decimal from "decimal.js";
import BN from "bn.js";
import Jupiter from "@/lib/jupiter";
import RaydiumCLMM from "@/lib/raydium-clmm";
import { bn } from "@/lib/utils";
import { VersionedTransaction } from "@solana/web3.js";

const DEFAULT_EXECUTION_BUFFER_BPS = 200;
const MAX_SLIPPAGE_BPS = 10_000;

export const useTrade = (tokenAddress: string, tokenAtomicBalance: Decimal) => {
  const createTransaction = useCallback(
    async (params: {
      direction: "buy" | "sell";
      value: number;
      signer: PublicKey;
    }) => {
      const { direction, value, signer } = params;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("Trade value must be a positive number");
      }
      if (direction === "sell" && value > 100) {
        throw new Error("Sell percentage cannot exceed 100");
      }

      let atomicAmount;
      if (direction === "buy") {
        atomicAmount = new Decimal(value).mul(LAMPORTS_PER_SOL);
      } else {
        atomicAmount = tokenAtomicBalance.mul(value).div(100);
      }
      if (atomicAmount.lte(0)) {
        throw new Error("Trade amount is too small after conversion");
      }

      const data = await Jupiter.getOrder({
        inputMint:
          direction === "buy" ? NATIVE_MINT : new PublicKey(tokenAddress),
        outputMint:
          direction === "buy" ? new PublicKey(tokenAddress) : NATIVE_MINT,
        amount: bn(atomicAmount),
        signer,
      });

      if (data.error) {
        throw new Error(data.error);
      }

      if (data.transaction === null) {
        throw new Error("Invalid data from Jupiter.getOrder");
      }

      const transactionBuffer = Buffer.from(data.transaction, "base64");
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

      return transaction;
    },
    [tokenAddress, tokenAtomicBalance],
  );

  const createRaydiumTransaction = useCallback(
    async (params: {
      direction: "buy" | "sell";
      value: number;
      signer: PublicKey;
      poolAddress: PublicKey;
      slippageBps?: number;
    }): Promise<VersionedTransaction> => {
      const {
        direction,
        value,
        signer,
        poolAddress,
        slippageBps = 50,
      } = params;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("Trade value must be a positive number");
      }
      if (direction === "sell" && value > 100) {
        throw new Error("Sell percentage cannot exceed 100");
      }
      if (
        !Number.isSafeInteger(slippageBps) ||
        slippageBps < 0 ||
        slippageBps > MAX_SLIPPAGE_BPS
      ) {
        throw new Error(
          `Invalid slippage bps: ${slippageBps}. Expected integer 0-${MAX_SLIPPAGE_BPS}.`,
        );
      }

      const tokenMint = new PublicKey(tokenAddress);
      const inputMint = direction === "buy" ? NATIVE_MINT : tokenMint;
      const outputMint = direction === "buy" ? tokenMint : NATIVE_MINT;

      const amountIn: BN =
        direction === "buy"
          ? bn(new Decimal(value).mul(LAMPORTS_PER_SOL))
          : bn(tokenAtomicBalance.mul(value).div(100));
      if (amountIn.lte(new BN(0))) {
        throw new Error("Trade amount is too small after conversion");
      }

      const quote = await RaydiumCLMM.getQuote({
        poolAddress,
        inputMint,
        outputMint,
        amountIn,
        slippageBps,
      });

      // Execution buffer absorbs slot-to-slot price movement after quote.
      const executionBufferBps = getExecutionBufferBps();
      const minimumAmountOut = new BN(quote.minimumOut)
        .mul(new BN(10000 - executionBufferBps))
        .div(new BN(10000));
      if (minimumAmountOut.lte(new BN(0))) {
        throw new Error(
          "Minimum output is zero after slippage/execution buffer. Increase trade amount or reduce protection settings.",
        );
      }

      return RaydiumCLMM.buildSwapTransaction({
        payer: signer,
        poolAddress,
        inputMint,
        outputMint,
        amountIn,
        minimumAmountOut,
      });
    },
    [tokenAddress, tokenAtomicBalance],
  );

  return {
    createTransaction,
    createRaydiumTransaction,
  };
};

function getExecutionBufferBps(): number {
  const raw = Number(import.meta.env.VITE_RAYDIUM_EXECUTION_BUFFER_BPS);
  if (Number.isSafeInteger(raw) && raw >= 0 && raw <= 5_000) {
    return raw;
  }
  return DEFAULT_EXECUTION_BUFFER_BPS;
}
