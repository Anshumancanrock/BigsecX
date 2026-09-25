/** A page's title row: the title on the left, page actions on the right. */

import { go } from "../lib/router.ts";

export function PageHead({
  title,
  back,
  children,
}: {
  title: React.ReactNode;
  /** A way back to the list a detail page came from. */
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
