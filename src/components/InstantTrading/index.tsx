import { useState, useCallback, useRef, useMemo } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { toast } from "sonner";
import {
  EnhancedToken,
  PairFilterResult,
} from "@codex-data/sdk/dist/sdk/generated/graphql";
import { RAYDIUM_CLMM_PROGRAM_ID } from "@/lib/raydium-clmm";
import { useTokenPageContext } from "@/pages/hooks/useTokenPageContext";
import { useTokenBalanceContext } from "@/pages/hooks/useTokenBalanceContext";
import { useTrade } from "@/hooks/use-trade";
import {
  confirmTransaction,
  createConnection,
  createKeypair,
  sendTransaction,
  signTransaction,
} from "@/lib/solana";
import { InstantTradingContent } from "./instant-trading-content";
import {
  RESIZE_CURSORS,
  ResizeDir,
  useFloatingLayout,
} from "./use-floating-layout";

interface InstantTradingProps {
  token: EnhancedToken;
  pairs?: PairFilterResult[];
}

const BUY_PRESETS = [0.0001, 0.001, 0.01, 0.1, 0.2, 0.5, 1, 2];
const SELL_PRESETS = [5, 10, 15, 25, 50, 75, 90, 100];

const MIN_W = 300;
const MAX_W = 600;
const MIN_H = 290;
const MAX_H = 400;
const STORAGE_KEY = "instant_trading_layout_v1";

function isRaydiumClmmPair(pair: PairFilterResult): boolean {
  const factoryAddr = pair.exchange?.id?.split(":")[0] ?? "";
  const exchangeName = pair.exchange?.name?.toLowerCase() ?? "";
  return (
    factoryAddr === RAYDIUM_CLMM_PROGRAM_ID.toBase58() ||
    exchangeName.includes("raydium clmm")
  );
}

export const InstantTrading = ({ token, pairs = [] }: InstantTradingProps) => {
  const { visible, setVisible, isDesktop } = useTokenPageContext();
  const { pos, size, isDragging, onHeaderMouseDown, onResizeMouseDown } =
    useFloatingLayout({
      storageKey: STORAGE_KEY,
      minW: MIN_W,
      maxW: MAX_W,
      minH: MIN_H,
      maxH: MAX_H,
    });

  const [buyAmount, setBuyAmount] = useState("");
  const [sellPct, setSellPct] = useState("");
  const [isTrading, setIsTrading] = useState(false);

  const tradeInFlight = useRef(false);

  const hasPrivateKey = !!import.meta.env.VITE_SOLANA_PRIVATE_KEY;
  const keypair = useMemo(() => {
    if (!hasPrivateKey) return null;
    return createKeypair(import.meta.env.VITE_SOLANA_PRIVATE_KEY);
  }, [hasPrivateKey]);

  const connection = useMemo(() => createConnection(), []);

  const { nativeBalance, tokenBalance, tokenAtomicBalance, refreshBalance } =
    useTokenBalanceContext();

  const { createTransaction, createRaydiumTransaction } = useTrade(
    token.address,
    tokenAtomicBalance,
  );

  const showAllPresets = size.height >= 360;
  const visibleBuyPresets = showAllPresets
    ? BUY_PRESETS
    : BUY_PRESETS.slice(0, 4);
  const visibleSellPresets = showAllPresets
    ? SELL_PRESETS
    : SELL_PRESETS.slice(0, 4);

  const bestClmmPool = useMemo<PublicKey | null>(() => {
    const solMint = new PublicKey(NATIVE_MINT);

    const clmmPairs = pairs
      .filter(isRaydiumClmmPair)
      .filter((p) => !!p.pair?.address)
      .filter(
        (p) =>
          p.token0?.address === solMint.toBase58() ||
          p.token1?.address === solMint.toBase58(),
      )
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

  const handleTrade = useCallback(
    async (direction: "buy" | "sell") => {
      if (!keypair) {
        toast.error("VITE_SOLANA_PRIVATE_KEY not configured");
        return;
      }
      if (tradeInFlight.current) return;

      const value =
        direction === "buy" ? parseFloat(buyAmount) : parseFloat(sellPct);

      if (!Number.isFinite(value) || value <= 0) {
        toast.error("Enter a valid amount");
        return;
      }
      if (direction === "buy" && value > nativeBalance) {
        toast.error("Insufficient SOL balance");
        return;
      }
      if (direction === "sell" && value > 100) {
        toast.error("Sell percentage cannot exceed 100%");
        return;
      }

      tradeInFlight.current = true;
      setIsTrading(true);
      const toastId = toast.loading("Submitting trade...");

      try {
        let tx;

        if (bestClmmPool) {
          toast.loading("Building Raydium CLMM transaction...", {
            id: toastId,
          });
          try {
            tx = await createRaydiumTransaction({
              direction,
              value,
              signer: keypair.publicKey,
              poolAddress: bestClmmPool,
            });
          } catch (error) {
            console.warn("CLMM path failed, fallback to Jupiter:", error);
            toast.loading("CLMM unavailable, falling back to Jupiter...", {
              id: toastId,
            });
            tx = await createTransaction({
              direction,
              value,
              signer: keypair.publicKey,
            });
          }
        } else {
          toast.loading("Fetching Jupiter quote...", { id: toastId });
          tx = await createTransaction({
            direction,
            value,
            signer: keypair.publicKey,
          });
        }

        toast.loading("Signing...", { id: toastId });
        const signed = signTransaction(keypair, tx);

        toast.loading("Sending...", { id: toastId });
        const sig = await sendTransaction(signed, connection);

        toast.loading("Confirming...", { id: toastId });
        const conf = await confirmTransaction(sig, connection);
        if (conf.value.err) throw new Error("Trade failed");

        toast.success(`Success! TX: ${sig.slice(0, 8)}...`, { id: toastId });
        setTimeout(refreshBalance, 1000);
        if (direction === "buy") setBuyAmount("");
        else setSellPct("");
      } catch (err) {
        toast.error((err as Error).message, { id: toastId });
      } finally {
        tradeInFlight.current = false;
        setIsTrading(false);
      }
    },
    [
      bestClmmPool,
      buyAmount,
      connection,
      createRaydiumTransaction,
      createTransaction,
      keypair,
      nativeBalance,
      refreshBalance,
      sellPct,
    ],
  );

  if (!isDesktop || !visible) return null;

  const sym = token.symbol || "TOKEN";

  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: size.width,
        height: size.height,
        zIndex: 9999,
        userSelect: "none",
      }}
    >
      <InstantTradingContent
        isDragging={isDragging}
        onHeaderMouseDown={onHeaderMouseDown}
        onClose={() => setVisible(false)}
        visibleBuyPresets={visibleBuyPresets}
        visibleSellPresets={visibleSellPresets}
        buyAmount={buyAmount}
        sellPct={sellPct}
        setBuyAmount={setBuyAmount}
        setSellPct={setSellPct}
        handleTrade={handleTrade}
        isTrading={isTrading}
        hasPrivateKey={hasPrivateKey}
        sym={sym}
        bestClmmPool={bestClmmPool}
        nativeBalance={nativeBalance}
        tokenBalance={tokenBalance}
      />

      <ResizeHandle
        dir="nw"
        style={{ top: 0, left: 0, width: 10, height: 10 }}
        onMouseDown={onResizeMouseDown}
      />
      <ResizeHandle
        dir="ne"
        style={{ top: 0, right: 0, width: 10, height: 10 }}
        onMouseDown={onResizeMouseDown}
      />
      <ResizeHandle
        dir="sw"
        style={{ bottom: 0, left: 0, width: 10, height: 10 }}
        onMouseDown={onResizeMouseDown}
      />
      <ResizeHandle
        dir="se"
        style={{ bottom: 0, right: 0, width: 10, height: 10 }}
        onMouseDown={onResizeMouseDown}
      />
      <ResizeHandle
        dir="n"
        style={{ top: 0, left: 10, right: 10, height: 5 }}
        onMouseDown={onResizeMouseDown}
      />
      <ResizeHandle
        dir="s"
        style={{ bottom: 0, left: 10, right: 10, height: 5 }}
        onMouseDown={onResizeMouseDown}
      />
      <ResizeHandle
        dir="w"
        style={{ left: 0, top: 10, bottom: 10, width: 5 }}
        onMouseDown={onResizeMouseDown}
      />
      <ResizeHandle
        dir="e"
        style={{ right: 0, top: 10, bottom: 10, width: 5 }}
        onMouseDown={onResizeMouseDown}
      />
    </div>
  );
};

interface ResizeHandleProps {
  dir: ResizeDir;
  style: CSSProperties;
  onMouseDown: (e: ReactMouseEvent, dir: ResizeDir) => void;
}

function ResizeHandle({ dir, style, onMouseDown }: ResizeHandleProps) {
  return (
    <div
      style={{
        position: "absolute",
        cursor: RESIZE_CURSORS[dir],
        zIndex: 10,
        ...style,
      }}
      onMouseDown={(e) => onMouseDown(e, dir)}
    />
  );
}
