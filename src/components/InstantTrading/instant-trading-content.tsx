import { Settings, Pencil, X } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { cn } from "@/lib/utils";

interface InstantTradingContentProps {
  isDragging: boolean;
  onHeaderMouseDown: (e: React.MouseEvent) => void;
  onClose: () => void;
  visibleBuyPresets: number[];
  visibleSellPresets: number[];
  buyAmount: string;
  sellPct: string;
  setBuyAmount: (value: string) => void;
  setSellPct: (value: string) => void;
  handleTrade: (direction: "buy" | "sell") => void;
  isTrading: boolean;
  hasPrivateKey: boolean;
  sym: string;
  bestClmmPool: PublicKey | null;
  nativeBalance: number;
  tokenBalance: number;
}

export function InstantTradingContent(props: InstantTradingContentProps) {
  const {
    isDragging,
    onHeaderMouseDown,
    onClose,
    visibleBuyPresets,
    visibleSellPresets,
    buyAmount,
    sellPct,
    setBuyAmount,
    setSellPct,
    handleTrade,
    isTrading,
    hasPrivateKey,
    sym,
    bestClmmPool,
    nativeBalance,
    tokenBalance,
  } = props;

  return (
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
            onClick={onClose}
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
                onClick={() => setBuyAmount(buyAmount === String(p) ? "" : String(p))}
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
                onClick={() => setSellPct(sellPct === String(p) ? "" : String(p))}
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
            disabled={isTrading || !hasPrivateKey || !buyAmount || parseFloat(buyAmount) <= 0}
            className="py-2 text-[11px] font-bold bg-[#0b3a1c]/90 text-[#3ddd72] border border-[#1a5e30] rounded-lg hover:bg-[#0b3a1c] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            {isTrading ? "..." : `Buy ${sym}`}
          </button>
          <button
            onClick={() => handleTrade("sell")}
            disabled={isTrading || !hasPrivateKey || !sellPct || parseFloat(sellPct) <= 0}
            className="py-2 text-[11px] font-bold bg-[#3a0c18]/90 text-[#f04060] border border-[#5e1a28] rounded-lg hover:bg-[#3a0c18] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            {isTrading ? "..." : `Sell ${sym}`}
          </button>
        </div>

        <div className="text-[10px] text-[#40404a] text-center">
          Route: {bestClmmPool ? "Raydium CLMM (fallback Jupiter)" : "Jupiter"}
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
  );
}

