/**
 * Entry point. The landing page and the app are separate trees with separate
 * styles, so neither has to override the other.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./landing/Landing.tsx";
import { AppShell } from "./app/AppShell.tsx";
import { ErrorBoundary } from "./app/ErrorBoundary.tsx";
import { WalletProvider } from "./features/wallet/WalletContext.tsx";
import { usePath } from "./lib/router.ts";
import "./styles/theme.css";

function Root() {
  const path = usePath();
  // The provider wraps both trees: the landing page reads no wallet state
  // today, but a "connect" affordance there should not need a second one.
  return (
    <WalletProvider>{path === "/" ? <Landing /> : <AppShell path={path} />}</WalletProvider>
  );
}

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from index.html");

createRoot(host).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
