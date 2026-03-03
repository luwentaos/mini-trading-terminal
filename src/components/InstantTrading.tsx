import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { toast } from "sonner";
import { X, Settings, Pencil } from "lucide-react";
import {
  EnhancedToken,
  PairFilterResult,
} from "@codex-data/sdk/dist/sdk/generated/graphql";
import { cn } from "@/lib/utils";
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

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_CURSORS: Record<ResizeDir, string> = {
  n: "n-resize",
  s: "s-resize",
  e: "e-resize",
  w: "w-resize",
  ne: "ne-resize",
  nw: "nw-resize",
  se: "se-resize",
  sw: "sw-resize",
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRaydiumClmmPair(pair: PairFilterResult): boolean {
  const factoryAddr = pair.exchange?.id?.split(":")[0] ?? "";
  const exchangeName = pair.exchange?.name?.toLowerCase() ?? "";
  return (
    factoryAddr === RAYDIUM_CLMM_PROGRAM_ID.toBase58() ||
    exchangeName.includes("raydium clmm")
  );
}

function readLayoutFromStorage(): {
  pos: { x: number; y: number };
  size: { width: number; height: number };
} {
  if (typeof window === "undefined") {
    return {
      pos: { x: 100, y: 80 },
      size: { width: 300, height: 290 },
    };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };

    return {
      pos: {
        x: clamp(parsed.x, 0, Math.max(0, window.innerWidth - parsed.width)),
        y: clamp(parsed.y, 0, Math.max(0, window.innerHeight - 60)),
      },
      size: {
        width: clamp(parsed.width, MIN_W, MAX_W),
        height: clamp(parsed.height, MIN_H, MAX_H),
      },
    };
  } catch {
    return {
      pos: { x: Math.max(0, window.innerWidth / 2), y: 150 },
      size: { width: 300, height: 290 },
    };
  }
}

export const InstantTrading = ({ token, pairs = [] }: InstantTradingProps) => {
  const { visible, setVisible, isDesktop } = useTokenPageContext();
  const layout = useMemo(() => readLayoutFromStorage(), []);

  const [pos, setPos] = useState(layout.pos);
  const [size, setSize] = useState(layout.size);
  const [isDragging, setIsDragging] = useState(false);
  const [buyAmount, setBuyAmount] = useState("");
  const [sellPct, setSellPct] = useState("");
  const [isTrading, setIsTrading] = useState(false);

  const dragging = useRef(false);
  const rafId = useRef<number | null>(null);
  const tradeInFlight = useRef(false);
  const dragOrigin = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const resizeDir = useRef<ResizeDir | null>(null);
  const resizeOrigin = useRef({ mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0 });
  const posRef = useRef(pos);
  const sizeRef = useRef(size);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
      }),
    );
  }, [pos, size]);

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
    const SOL_MINT = new PublicKey(NATIVE_MINT);

    const clmmPairs = pairs
      .filter(isRaydiumClmmPair)
      .filter((p) => !!p.pair?.address)
      .filter(
        (p) =>
          p.token0?.address === SOL_MINT.toBase58() ||
          p.token1?.address === SOL_MINT.toBase58(),
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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current && !resizeDir.current) return;
      if (rafId.current) return;

      rafId.current = window.requestAnimationFrame(() => {
        rafId.current = null;

        if (dragging.current) {
          const dx = e.clientX - dragOrigin.current.mx;
          const dy = e.clientY - dragOrigin.current.my;

          setPos({
            x: clamp(
              dragOrigin.current.px + dx,
              0,
              window.innerWidth - sizeRef.current.width,
            ),
            y: clamp(dragOrigin.current.py + dy, 0, window.innerHeight - 60),
          });
        }

        if (resizeDir.current) {
          const dx = e.clientX - resizeOrigin.current.mx;
          const dy = e.clientY - resizeOrigin.current.my;
          const { x: ox, y: oy, w: ow, h: oh } = resizeOrigin.current;
          const dir = resizeDir.current;

          let newX = ox;
          let newY = oy;
          let newW = ow;
          let newH = oh;

          if (dir.includes("e")) {
            newW = clamp(ow + dx, MIN_W, MAX_W);
          }
          if (dir.includes("s")) {
            newH = clamp(oh + dy, MIN_H, MAX_H);
          }
          if (dir.includes("w")) {
            newW = clamp(ow - dx, MIN_W, MAX_W);
            newX = ox + (ow - newW);
          }
          if (dir.includes("n")) {
            newH = clamp(oh - dy, MIN_H, MAX_H);
            newY = oy + (oh - newH);
          }

          newX = clamp(newX, 0, window.innerWidth - newW);
          newY = clamp(newY, 0, window.innerHeight - 60);

          setPos({ x: newX, y: newY });
          setSize({ width: newW, height: newH });
        }
      });
    };

    const onUp = () => {
      dragging.current = false;
      resizeDir.current = null;
      setIsDragging(false);
      document.body.style.cursor = "";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      if (rafId.current) {
        window.cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onHeaderMouseDown = useCallback((e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;

    dragging.current = true;
    setIsDragging(true);
    dragOrigin.current = {
      mx: e.clientX,
      my: e.clientY,
      px: posRef.current.x,
      py: posRef.current.y,
    };

    document.body.style.cursor = "move";
    e.preventDefault();
  }, []);

  const onResizeMouseDown = useCallback(
    (e: ReactMouseEvent, dir: ResizeDir) => {
      resizeDir.current = dir;
      resizeOrigin.current = {
        mx: e.clientX,
        my: e.clientY,
        x: posRef.current.x,
        y: posRef.current.y,
        w: sizeRef.current.width,
        h: sizeRef.current.height,
      };
      document.body.style.cursor = RESIZE_CURSORS[dir];
      e.preventDefault();
      e.stopPropagation();
    },
    [],
  );

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
      keypair,
      buyAmount,
      sellPct,
      nativeBalance,
      bestClmmPool,
      createRaydiumTransaction,
      createTransaction,
      connection,
      refreshBalance,
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
      <div
        className="absolute inset-0 flex flex-col bg-[#0d0d0f] border border-[#242428] rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.7)] overflow-hidden"
        style={{
          opacity: isDragging ? 0.85 : 1,
          transition: isDragging ? "none" : "opacity 0.15s ease",
        }}
      >
        <div
          className="flex items-center justify-between px-1.5 py-1.5 bg-[#111113] border-b border-[#1d1d21] select-none shrink-0"
          style={{ cursor: "move" }}
          onMouseDown={onHeaderMouseDown}
        >
          <div className="flex items-center gap-0.5">
            <button
              data-no-drag="true"
              className="ml-0.5 p-1.5 text-[#40404a] hover:text-[#888] rounded-md transition-colors"
            >
              <Settings size={11} />
            </button>
          </div>

          <div className="flex items-center gap-0.5" data-no-drag="true">
            <button className="p-1.5 text-[#40404a] hover:text-[#888] rounded-md transition-colors">
              <Pencil size={11} />
            </button>
            <button
              onClick={() => setVisible(false)}
              className="p-1.5 text-[#40404a] hover:text-[#ccc] rounded-md transition-colors"
            >
              <X size={11} />
            </button>
          </div>
        </div>

        <div className="instant-scroll-hide flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] p-2 space-y-1.5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-0.5 font-bold text-white text-[13px]">
              Buy
            </div>

            <div className="grid grid-cols-4 gap-1">
              {visibleBuyPresets.map((p) => (
                <button
                  key={p}
                  onClick={() =>
                    setBuyAmount(buyAmount === String(p) ? "" : String(p))
                  }
                  className={cn(
                    "py-[7px] text-[11px] font-semibold rounded-md border transition-all",
                    buyAmount === String(p)
                      ? "bg-[#0b3a1c] text-[#3ddd72] border-[#1a5e30]"
                      : "bg-transparent text-[#3ddd72] border-[#152e1e] hover:bg-[#0b3a1c]/70",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 py-0.5">
            <div className="flex-1 h-px bg-[#1c1c20]" />
            <span className="text-[9px] text-[#343438] font-semibold tracking-[0.15em]">
              OR
            </span>
            <div className="flex-1 h-px bg-[#1c1c20]" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-0.5 font-bold text-white text-[13px]">
              Sell
            </div>

            <div className="grid grid-cols-4 gap-1">
              {visibleSellPresets.map((p) => (
                <button
                  key={p}
                  onClick={() =>
                    setSellPct(sellPct === String(p) ? "" : String(p))
                  }
                  className={cn(
                    "py-[7px] text-[11px] font-semibold rounded-md border transition-all",
                    sellPct === String(p)
                      ? "bg-[#3a0c18] text-[#f04060] border-[#5e1a28]"
                      : "bg-transparent text-[#e03c58] border-[#2e0f18] hover:bg-[#3a0c18]/70",
                  )}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5 pt-1">
            <button
              onClick={() => handleTrade("buy")}
              disabled={
                isTrading ||
                !hasPrivateKey ||
                !buyAmount ||
                parseFloat(buyAmount) <= 0
              }
              className="py-2 text-[11px] font-bold bg-[#0b3a1c]/90 text-[#3ddd72] border border-[#1a5e30] rounded-lg hover:bg-[#0b3a1c] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {isTrading ? "..." : `Buy ${sym}`}
            </button>
            <button
              onClick={() => handleTrade("sell")}
              disabled={
                isTrading ||
                !hasPrivateKey ||
                !sellPct ||
                parseFloat(sellPct) <= 0
              }
              className="py-2 text-[11px] font-bold bg-[#3a0c18]/90 text-[#f04060] border border-[#5e1a28] rounded-lg hover:bg-[#3a0c18] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {isTrading ? "..." : `Sell ${sym}`}
            </button>
          </div>

          <div className="text-[10px] text-[#40404a] text-center">
            Route:{" "}
            {bestClmmPool ? "Raydium CLMM (fallback Jupiter)" : "Jupiter"}
          </div>

          {!hasPrivateKey && (
            <p className="text-[10px] text-[#50404a] text-center pt-0.5">
              Set VITE_SOLANA_PRIVATE_KEY to enable trading
            </p>
          )}
        </div>

        <div className="shrink-0 px-3 py-1.5 border-t border-[#1d1d21] flex justify-between text-[10px] text-[#45454f] bg-[#111113]">
          <span>SOL: {nativeBalance.toFixed(4)}</span>
          <span>
            {sym}: {tokenBalance.toLocaleString()}
          </span>
        </div>
      </div>

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
