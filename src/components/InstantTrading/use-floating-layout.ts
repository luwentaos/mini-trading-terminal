import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_CURSORS: Record<ResizeDir, string> = {
  n: "n-resize",
  s: "s-resize",
  e: "e-resize",
  w: "w-resize",
  ne: "ne-resize",
  nw: "nw-resize",
  se: "se-resize",
  sw: "sw-resize",
};

interface UseFloatingLayoutArgs {
  storageKey: string;
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readLayoutFromStorage(args: UseFloatingLayoutArgs): {
  pos: { x: number; y: number };
  size: { width: number; height: number };
} {
  const { storageKey, minW, maxW, minH, maxH } = args;
  if (typeof window === "undefined") {
    return {
      pos: { x: 100, y: 80 },
      size: { width: minW, height: minH },
    };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
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
        width: clamp(parsed.width, minW, maxW),
        height: clamp(parsed.height, minH, maxH),
      },
    };
  } catch {
    return {
      pos: { x: Math.max(0, window.innerWidth / 2), y: 150 },
      size: { width: minW, height: minH },
    };
  }
}

export function useFloatingLayout(args: UseFloatingLayoutArgs) {
  const { storageKey, minW, maxW, minH, maxH } = args;
  const layout = useMemo(() => readLayoutFromStorage(args), [args]);

  const [pos, setPos] = useState(layout.pos);
  const [size, setSize] = useState(layout.size);
  const [isDragging, setIsDragging] = useState(false);

  const dragging = useRef(false);
  const rafId = useRef<number | null>(null);
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
      storageKey,
      JSON.stringify({
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
      }),
    );
  }, [pos, size, storageKey]);

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

          if (dir.includes("e")) newW = clamp(ow + dx, minW, maxW);
          if (dir.includes("s")) newH = clamp(oh + dy, minH, maxH);
          if (dir.includes("w")) {
            newW = clamp(ow - dx, minW, maxW);
            newX = ox + (ow - newW);
          }
          if (dir.includes("n")) {
            newH = clamp(oh - dy, minH, maxH);
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
  }, [maxH, maxW, minH, minW]);

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

  return { pos, size, isDragging, onHeaderMouseDown, onResizeMouseDown };
}

