import { createContext, useContext, useState, useMemo, useEffect } from "react";
import { getIsDesktop } from "@/lib/utils";

type TokenPageContextType = {
  visible: boolean;
  setVisible: (visible: boolean) => void;
  isDesktop: boolean;
};
export const TokenPageContext = createContext<TokenPageContextType | undefined>(
  undefined,
);

export function TokenPageProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [isDesktop, setIsDesktop] = useState(getIsDesktop(window.innerWidth));

  useEffect(() => {
    const onResize = () => {
      setIsDesktop(getIsDesktop(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const value = useMemo(
    () => ({
      visible,
      setVisible,
      isDesktop,
    }),
    [visible, setVisible, isDesktop],
  );

  return (
    <TokenPageContext.Provider value={value}>
      {children}
    </TokenPageContext.Provider>
  );
}

export const useTokenPageContext = (): TokenPageContextType => {
  const context = useContext(TokenPageContext);
  if (!context) {
    throw new Error("need provider");
  }

  return context;
};
