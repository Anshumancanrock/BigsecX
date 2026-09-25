import { go } from "../lib/router.ts";

export function PageHead({
  title,
  back,
  children,
}: {
  title: React.ReactNode;
  back?: { readonly href: string; readonly label: string } | undefined;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        {back ? (
          <a className="page-back" href={back.href} onClick={go(back.href)}>
            ← {back.label}
          </a>
        ) : null}
        <h1 className="page-title">{title}</h1>
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  );
}
