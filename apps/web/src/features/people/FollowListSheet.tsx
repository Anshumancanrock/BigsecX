import { useState } from "react";
import { api, type FollowEntry } from "../../lib/api.ts";
import { shortAddress, displayName } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { Sheet } from "../../components/Sheet.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Face } from "./Face.tsx";

export function FollowListSheet({
  wallet,
  initial,
  onClose,
}: {
  wallet: string;
  initial: "followers" | "following";
  onClose: () => void;
}) {
  const [side, setSide] = useState(initial);
  const followers = useAsync<readonly FollowEntry[]>(
    (signal) => api.followers(wallet, signal).then((r) => r.followers),
    [wallet],
  );
  const following = useAsync<readonly FollowEntry[]>(
    (signal) => api.following(wallet, signal).then((r) => r.following),
    [wallet],
  );
  const rows = side === "followers" ? followers : following;

  return (
    <Sheet title={side === "followers" ? "Followers" : "Following"} onClose={onClose}>
      <Segmented
        className="sheet-seg"
        label="Followers or following"
        options={[
          { value: "followers", label: `Followers${followers.data ? ` · ${followers.data.length}` : ""}` },
          { value: "following", label: `Following${following.data ? ` · ${following.data.length}` : ""}` },
        ]}
        value={side}
        onChange={setSide}
      />
      {rows.error ? (
        <p className="note">Could not load this list just now.</p>
      ) : !rows.data ? (
        <div className="shimmer" style={{ height: 180, marginTop: 12 }} />
      ) : rows.data.length === 0 ? (
        <p className="note" style={{ padding: "18px 2px" }}>
          {side === "followers" ? "Nobody follows this wallet yet." : "This wallet does not follow anyone yet."}
        </p>
      ) : (
        <div className="people-list">
          {rows.data.map((entry) => (
            <button
              key={entry.wallet}
              className="person-row"
              onClick={() => {
                onClose();
                navigate(`/traders/${entry.wallet}`);
              }}
            >
              <Face wallet={entry.wallet} avatar={entry.avatar} size={40} />
              <span className="person-text">
                <b>{displayName(entry.wallet, entry.name, entry.handle)}</b>
                <small>
                  {entry.handle ? `@${entry.handle} · ` : ""}
                  {shortAddress(entry.wallet, 4, 4)}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
