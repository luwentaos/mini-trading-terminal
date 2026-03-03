import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  EnhancedToken,
  PairFilterResult,
} from "@codex-data/sdk/dist/sdk/generated/graphql";
import { useTrade } from "@/hooks/use-trade";
import { useTokenBalanceContext } from "@/pages/hooks/useTokenBalanceContext";
import {
  confirmTransaction,
  createConnection,
  createKeypair,
  sendTransaction,
  signTransaction,
} from "@/lib/solana";
import { RAYDIUM_CLMM_PROGRAM_ID } from "@/lib/raydium-clmm";

// Raydium CLMM 的识别：exchange.id 格式为 "<factoryAddress>:<networkId>"
// 同时兼容 exchange.name 包含 "raydium clmm" 的情况
function isRaydiumClmmPair(pair: PairFilterResult): boolean {
  const factoryAddr = pair.exchange?.id?.split(":")[0] ?? "";
  const exchangeName = pair.exchange?.name?.toLowerCase() ?? "";
  return (
    factoryAddr === RAYDIUM_CLMM_PROGRAM_ID.toBase58() ||
    exchangeName.includes("raydium clmm")
  );
}

interface TradingPanelProps {
  token: EnhancedToken;
  pairs?: PairFilterResult[];
}

export function TradingPanel({ token, pairs = [] }: TradingPanelProps) {
  const tokenSymbol = token.symbol;
  const [tradeMode, setTradeMode] = useState<"buy" | "sell">("buy");
  const [buyAmount, setBuyAmount] = useState("");
  const [sellPercentage, setSellPercentage] = useState("");

  const {
    nativeBalance: solanaBalance,
    tokenBalance,
    tokenAtomicBalance,
    loading,
    refreshBalance,
  } = useTokenBalanceContext();
  const { createTransaction, createRaydiumTransaction } = useTrade(
    token.address,
    tokenAtomicBalance,
  );

  const keypair = createKeypair(import.meta.env.VITE_SOLANA_PRIVATE_KEY);
  const connection = createConnection();

  // 从 Codex pairs 中挑选流动性最高的 Raydium CLMM pool
  const bestClmmPool = useMemo<PublicKey | null>(() => {
    const SOL_MINT = new PublicKey(NATIVE_MINT);
    const clmmPairs = pairs
      .filter(isRaydiumClmmPair)
      .filter((p) => !!p.pair?.address)
      // 关键过滤：必须包含 SOL mint
      .filter(
        (p) =>
          p.token0?.address === SOL_MINT.toBase58() ||
          p.token1?.address === SOL_MINT.toBase58(),
      )
      // 优先流动性（TVL）
      .sort(
        (a, b) =>
          parseFloat(b.liquidity ?? "0") - parseFloat(a.liquidity ?? "0"),
      );

    if (clmmPairs.length === 0) return null;

    try {
      return new PublicKey(clmmPairs[0].pair!.address);
    } catch {
      return null;
    }
  }, [pairs]);

  const handleTrade = useCallback(async () => {
    const toastId = toast.loading("Submitting trade request...");
    try {
      const tradeValue =
        tradeMode === "buy"
          ? parseFloat(buyAmount)
          : parseFloat(sellPercentage);
      if (!Number.isFinite(tradeValue) || tradeValue <= 0) {
        throw new Error("Invalid trade amount");
      }

      let transaction;

      if (bestClmmPool) {
        // Raydium CLMM 直接路由
        toast.loading("Building Raydium CLMM transaction...", { id: toastId });
        transaction = await createRaydiumTransaction({
          direction: tradeMode,
          value: tradeValue,
          signer: keypair.publicKey,
          poolAddress: bestClmmPool,
        });
      } else {
        // 回退到 Jupiter 聚合
        toast.loading("Fetching Jupiter quote...", { id: toastId });
        transaction = await createTransaction({
          direction: tradeMode,
          value: tradeValue,
          signer: keypair.publicKey,
        });
      }

      toast.loading("Signing transaction...", { id: toastId });
      const signedTransaction = signTransaction(keypair, transaction);

      toast.loading("Sending transaction...", { id: toastId });
      const signature = await sendTransaction(signedTransaction, connection);

      toast.loading("Confirming transaction...", { id: toastId });
      const confirmation = await confirmTransaction(signature, connection);

      if (confirmation.value.err) {
        throw new Error("Trade failed");
      }
      toast.success(`Trade successful! TX: ${signature.slice(0, 8)}...`, {
        id: toastId,
      });

      // Refresh balance after 1 second
      setTimeout(refreshBalance, 1000);
    } catch (error) {
      toast.error((error as Error).message, { id: toastId });
    }
  }, [
    tradeMode,
    buyAmount,
    sellPercentage,
    bestClmmPool,
    createTransaction,
    createRaydiumTransaction,
    keypair,
    connection,
    refreshBalance,
  ]);

  const solBuyAmountPresets = [0.0001, 0.001, 0.01, 0.1];
  const percentagePresets = [25, 50, 75, 100];

  if (
    !import.meta.env.VITE_SOLANA_PRIVATE_KEY ||
    !import.meta.env.VITE_HELIUS_RPC_URL ||
    !import.meta.env.VITE_JUPITER_REFERRAL_ACCOUNT
  ) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Trade {tokenSymbol || "Token"}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Trading requires VITE_SOLANA_PRIVATE_KEY, VITE_HELIUS_RPC_URL and
            VITE_JUPITER_REFERRAL_ACCOUNT to be configured in environment
            variables.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Trade {tokenSymbol || "Token"}</CardTitle>
          <button
            onClick={() => {
              navigator.clipboard.writeText(keypair.publicKey.toBase58());
              toast.success("Wallet address copied!");
            }}
            className="text-xs text-muted-foreground font-mono hover:text-foreground transition-colors cursor-pointer"
          >
            {keypair.publicKey.toBase58().slice(0, 4)}...
            {keypair.publicKey.toBase58().slice(-4)}
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between p-3 bg-muted/30 rounded-lg">
          <span className="text-sm text-muted-foreground">SOL Balance:</span>
          <span className="font-semibold">{solanaBalance.toFixed(4)} SOL</span>
        </div>

        {tokenSymbol && (
          <div className="flex justify-between p-3 bg-muted/30 rounded-lg">
            <span className="text-sm text-muted-foreground">
              {tokenSymbol} Balance:
            </span>
            <span className="font-semibold">
              {tokenBalance.toLocaleString()} {tokenSymbol}
            </span>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => setTradeMode("buy")}
            className={cn(
              "flex-1 py-2 px-4 rounded-lg font-medium transition-all",
              tradeMode === "buy"
                ? "bg-green-500/20 text-green-500 border border-green-500/50"
                : "bg-muted/30 text-muted-foreground hover:bg-muted/50",
            )}
          >
            Buy
          </button>
          <button
            onClick={() => setTradeMode("sell")}
            className={cn(
              "flex-1 py-2 px-4 rounded-lg font-medium transition-all",
              tradeMode === "sell"
                ? "bg-red-500/20 text-red-500 border border-red-500/50"
                : "bg-muted/30 text-muted-foreground hover:bg-muted/50",
            )}
          >
            Sell
          </button>
        </div>

        {tradeMode === "buy" ? (
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">
              Amount in SOL
            </label>
            <div className="flex gap-2">
              {solBuyAmountPresets.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setBuyAmount(preset.toString())}
                  className={cn(
                    "flex-1 py-1.5 px-2 rounded-md text-sm font-medium transition-all",
                    buyAmount === preset.toString()
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/30 text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {preset}
                </button>
              ))}
            </div>
            <Input
              type="number"
              placeholder="0.00"
              value={buyAmount}
              onChange={(e) => setBuyAmount(e.target.value)}
              min="0"
              step="0.01"
            />
            <div className="text-xs text-muted-foreground">
              Available: {solanaBalance.toFixed(4)} SOL
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="text-sm text-muted-foreground">
              Sell Percentage
            </label>
            <div className="flex gap-2">
              {percentagePresets.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setSellPercentage(preset.toString())}
                  className={cn(
                    "flex-1 py-1.5 px-2 rounded-md text-sm font-medium transition-all",
                    sellPercentage === preset.toString()
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/30 text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {preset}%
                </button>
              ))}
            </div>
            <Input
              type="number"
              placeholder="0"
              value={sellPercentage}
              onChange={(e) => setSellPercentage(e.target.value)}
              min="0"
              max="100"
              step="1"
            />
            {sellPercentage && tokenBalance > 0 && (
              <div className="text-xs text-muted-foreground">
                Selling:{" "}
                {(
                  (tokenBalance * parseFloat(sellPercentage)) /
                  100
                ).toLocaleString()}{" "}
                {tokenSymbol}
              </div>
            )}
          </div>
        )}

        <div>
          <span
            className={cn(
              "text-xs px-1.5 py-0.5 rounded font-medium",
              bestClmmPool
                ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                : "bg-muted/40 text-muted-foreground border border-border",
            )}
          >
            {bestClmmPool ? "Raydium CLMM" : "Jupiter"}
          </span>
        </div>

        <button
          onClick={handleTrade}
          disabled={
            loading ||
            (tradeMode === "buy" &&
              (!buyAmount || parseFloat(buyAmount) <= 0)) ||
            (tradeMode === "sell" &&
              (!sellPercentage || parseFloat(sellPercentage) <= 0))
          }
          className={cn(
            "w-full py-3 px-4 rounded-lg font-semibold transition-all",
            tradeMode === "buy"
              ? "bg-green-500 hover:bg-green-600 text-white disabled:bg-green-500/30 disabled:text-green-500/50"
              : "bg-red-500 hover:bg-red-600 text-white disabled:bg-red-500/30 disabled:text-red-500/50",
            "disabled:cursor-not-allowed",
          )}
        >
          {tradeMode === "buy" ? "Buy" : "Sell"} {tokenSymbol || "Token"}
        </button>
      </CardContent>
    </Card>
  );
}
