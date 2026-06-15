import { X } from "lucide-react";

export type ConfirmDialogDetail = { label: string; value: string; tone?: "accent" | "success" | "danger" };

export type ConfirmDialogRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  details?: ConfirmDialogDetail[];
  resolve: (confirmed: boolean) => void;
};

export function ConfirmDialog({ request, onClose }: { request: ConfirmDialogRequest | null; onClose: (confirmed: boolean) => void }) {
  if (!request) return null;
  return <div className="modal-overlay" role="presentation" onMouseDown={() => onClose(false)}>
    <section className={`confirm-modal ${request.danger ? "danger" : ""}`} role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="confirm-modal-title">
        <h3 id="confirm-modal-title">{request.title}</h3>
        <button className="icon-action" aria-label="Close dialog" onClick={() => onClose(false)}><X size={18} /></button>
      </div>
      <p>{request.message}</p>
      {request.details?.length ? <dl className="confirm-modal-details">
        {request.details.map((detail) => <div key={`${detail.label}-${detail.value}`}><dt>{detail.label}</dt><dd className={detail.tone || "accent"}>{detail.value}</dd></div>)}
      </dl> : null}
      <div className="confirm-modal-actions">
        <button onClick={() => onClose(false)}>{request.cancelLabel}</button>
        <button className={request.danger ? "danger" : "success"} onClick={() => onClose(true)}>{request.confirmLabel}</button>
      </div>
    </section>
  </div>;
}
