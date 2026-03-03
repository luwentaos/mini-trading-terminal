import { createContext, useContext, useMemo } from "react";
import Decimal from "decimal.js";
import { useBalance } from "@/hooks/use-balance";

type TokenBalanceContextType = {
  nativeBalance: number;
  nativeAtomicBalance: Decimal;
  tokenBalance: number;
  tokenAtomicBalance: Decimal;
  loading: boolean;
  refreshBalance: () => Promise<void>;
};

const TokenBalanceContext = createContext<TokenBalanceContextType | undefined>(
  undefined,
);

export function TokenBalanceProvider({
  tokenAddress,
  tokenDecimals,
  nativeDecimals,
  networkId,
  children,
}: {
  tokenAddress: string;
  tokenDecimals: number;
  nativeDecimals: number;
  networkId: number;
  children: React.ReactNode;
}) {
  const balance = useBalance(
    tokenAddress,
    tokenDecimals,
    nativeDecimals,
    networkId,
  );

  const value = useMemo(
    () => ({
      nativeBalance: balance.nativeBalance,
      nativeAtomicBalance: balance.nativeAtomicBalance,
      tokenBalance: balance.tokenBalance,
      tokenAtomicBalance: balance.tokenAtomicBalance,
      loading: balance.loading,
      refreshBalance: balance.refreshBalance,
    }),
    [
      balance.nativeBalance,
      balance.nativeAtomicBalance,
      balance.tokenBalance,
      balance.tokenAtomicBalance,
      balance.loading,
      balance.refreshBalance,
    ],
  );

  return (
    <TokenBalanceContext.Provider value={value}>
      {children}
    </TokenBalanceContext.Provider>
  );
}

export function useTokenBalanceContext(): TokenBalanceContextType {
  const ctx = useContext(TokenBalanceContext);
  if (!ctx) {
    throw new Error("useTokenBalanceContext must be used within TokenBalanceProvider");
  }
  return ctx;
}

