export function FoltioMark({ className = "foltio-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 34 34" aria-hidden="true" focusable="false">
      <rect className="fm-bg" x="1" y="1" width="32" height="32" rx="8" />
      <path className="fm-frame" d="M6.5 5.5h21v23h-21z" />
      <path className="fm-fold" d="M7 6h14.5L27 11.5 17 17 7 11.5z" />
      <path className="fm-play" d="m14.2 12.8 6.5 4.2-6.5 4.2z" />
      <path className="fm-tail" d="M7 22.5 17 17l10 5.5V28H7z" />
    </svg>
  );
}

export function FoltioBrand({ big = false }: { big?: boolean }) {
  return <span className={`foltio-brand ${big ? "big" : ""}`}><FoltioMark /><span>FOLTIO</span></span>;
}
