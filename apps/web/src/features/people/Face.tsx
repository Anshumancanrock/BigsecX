import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { avatarSrc, characterSrc, defaultCharacter, rememberAvatar, useKnownAvatar, hues } from "../../lib/avatars.ts";
import { useWallet } from "../wallet/WalletContext.tsx";

export function Face({
  wallet,
  avatar,
  size = 40,
}: {
  wallet: string;
  avatar?: string | null | undefined;
  size?: number;
}) {
  const known = useKnownAvatar(wallet);
  const src = avatarSrc(wallet, known !== undefined ? known : avatar);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = failed === src ? characterSrc(defaultCharacter(wallet)) : src;
  const [a, b] = hues(wallet);
  return (
    <span
      className="face"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(120% 120% at 20% 10%, hsl(${a} 70% 80%), hsl(${b} 55% 58%))`,
      }}
      aria-hidden="true"
    >
      <img
        src={shown}
        alt=""
        width={size}
        height={size}
        decoding="async"
        loading="lazy"
        draggable={false}
        onError={() => setFailed(src)}
      />
    </span>
  );
}

/**
 * Reads the connected wallet's own picture once, so its face is right in
 * the header and the tab bar before any page has fetched its profile.
 */
export function OwnAvatar() {
  const me = useWallet();
  useEffect(() => {
    const address = me.address;
    if (!address) return;
    const controller = new AbortController();
    api
      .profile(address, null, controller.signal)
      .then((profile) => rememberAvatar(address, profile.avatar ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, [me.address]);
  return null;
}
