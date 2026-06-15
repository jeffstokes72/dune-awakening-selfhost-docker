import { formatUiSentence } from "../../lib/display";

export type InlineActionResultState = {
  key: string;
  tone: "success" | "danger" | "neutral";
  text: string;
  pending?: boolean;
};

export function InlineActionResult({ result, resultKey }: { result: InlineActionResultState | null; resultKey: string }) {
  if (!result || result.key !== resultKey) return null;
  return <span className="inline-action-result-wrap"><span className={`inline-action-result ${result.tone} ${result.pending ? "pending" : ""}`}>{formatUiSentence(result.text, Boolean(result.pending))}</span></span>;
}
