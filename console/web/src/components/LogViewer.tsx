import { useEffect, useRef } from "react";

export function LogViewer({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return <pre ref={ref} className="log-box large">{text || "No logs loaded."}</pre>;
}
