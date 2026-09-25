import { useRef, useState } from "react";
import { ApiError, api, type Profile } from "../../lib/api.ts";
import {
  CHARACTERS,
  characterSrc,
  defaultCharacter,
  presetOf,
  rememberAvatar,
  useKnownAvatar,
} from "../../lib/avatars.ts";
import { PictureError, toProfilePicture } from "../../lib/picture.ts";
import { withSession, signInError } from "../../lib/session.ts";
import { useWallet } from "../wallet/WalletContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { Face } from "./Face.tsx";

/* ------------------------------------------------------- edit profile */

export function EditProfileSheet({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const me = useWallet();
  const toast = useToast();
  const [name, setName] = useState(profile.name);
  const [handle, setHandle] = useState(profile.handle ?? "");
  const [bio, setBio] = useState(profile.bio);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const cleanHandle = handle.trim().replace(/^@/, "");
  const handleOk = cleanHandle === "" || /^[A-Za-z0-9_]{3,20}$/.test(cleanHandle);
  const nameLength = [...name.trim()].length;
  const bioLength = [...bio.trim()].length;
  const valid = handleOk && nameLength <= 32 && bioLength <= 160;

  const save = async () => {
    if (!me.connection || !valid) return;
    setBusy(true);
    setProblem(null);
    try {
      await withSession(me.connection, (token) =>
        api.saveProfile({ token, name: name.trim(), handle: cleanHandle, bio: bio.trim() }),
      );
      toast("Profile saved", "good");
      onSaved();
      onClose();
    } catch (error) {
      setProblem(
        error instanceof ApiError && (error.status === 409 || error.status === 400)
          ? error.message.replace(/^./, (c) => c.toUpperCase())
          : signInError(error, "save"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Edit profile"
      onClose={onClose}
      footer={
        <button className="btn-mint wide" onClick={() => void save()} disabled={busy || !valid || !me.connection}>
          {busy ? "Saving…" : "Save"}
        </button>
      }
    >
      <PictureChooser wallet={profile.wallet} saved={profile.avatar} />
      <label className="edit-field">
        <span>
          Name <small>{nameLength}/32</small>
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} placeholder="What people call you" />
      </label>
      <label className="edit-field">
        <span>
          Username{" "}
          <small className={handleOk ? "" : "down"}>{handleOk ? "3–20 letters, numbers or _" : "Letters, numbers or _, 3–20 long"}</small>
        </span>
        <span className="edit-at">
          <i>@</i>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.replace(/\s/g, ""))}
            maxLength={21}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </span>
      </label>
      <label className="edit-field">
        <span>
          Bio <small className={bioLength > 160 ? "down" : ""}>{bioLength}/160</small>
        </span>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxLength={200} placeholder="What you invest in, and why" />
      </label>
      {problem ? <p className="note down" style={{ marginTop: 6 }}>{problem}</p> : null}
      <p className="note" style={{ marginTop: 10 }}>
        Saving asks your wallet to sign a message the first time (free, not a transaction) and keeps you signed in
        here for 30 days. Your address is always shown beside your name.
      </p>
    </Sheet>
  );
}

/* ------------------------------------------------------------- picture */

/**
 * Profile picture: an upload or one of the nine characters. Each choice is
 * saved immediately under the existing sign-in session.
 */
function PictureChooser({ wallet, saved }: { wallet: string; saved: string | null }) {
  const me = useWallet();
  const toast = useToast();
  const known = useKnownAvatar(wallet);
  const current = known !== undefined ? known : saved;
  const [busy, setBusy] = useState<"upload" | "clear" | number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // The character on show: chosen, or picked by the address when nothing is.
  const character = presetOf(current) ?? (current === null ? defaultCharacter(wallet) : null);

  const change = async (
    what: "upload" | "clear" | number,
    body: () => Promise<{ preset: number } | { image: string } | { clear: true }>,
    done: string,
  ) => {
    if (!me.connection || busy !== null) return;
    setBusy(what);
    setProblem(null);
    try {
      const payload = await body();
      const result = await withSession(me.connection, (token) => api.setAvatar({ token, ...payload }));
      rememberAvatar(wallet, result.avatar);
      toast(done, "good");
    } catch (error) {
      setProblem(
        error instanceof PictureError
          ? error.message
          : error instanceof ApiError && error.status === 400
            ? error.message.replace(/^./, (c) => c.toUpperCase())
            : signInError(error, "change your picture"),
      );
    } finally {
      setBusy(null);
    }
  };

  const upload = (file: File) =>
    void change("upload", async () => ({ image: (await toProfilePicture(file)).base64 }), "Picture updated");

  return (
    <section className="picture-chooser" aria-label="Profile picture">
      <div className="picture-top">
        <span className={`picture-face${busy === "upload" ? " busy" : ""}`}>
          <Face wallet={wallet} avatar={current} size={84} />
        </span>
        <span className="picture-words">
          <b>Profile picture</b>
          <small>Upload a photo, or pick one of our characters. It saves as soon as you choose.</small>
          <span className="picture-actions">
            <button
              className="btn-mint sm"
              onClick={() => input.current?.click()}
              disabled={busy !== null || !me.connection}
            >
              {busy === "upload" ? "Uploading…" : "Upload photo"}
            </button>
            {current !== null ? (
              <button
                className="btn-ghost sm"
                onClick={() => void change("clear", async () => ({ clear: true }), "Back to your character")}
                disabled={busy !== null || !me.connection}
              >
                {busy === "clear" ? "Resetting…" : "Reset"}
              </button>
            ) : null}
          </span>
        </span>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared, so choosing the same file again still counts as a choice.
            event.target.value = "";
            if (file) upload(file);
          }}
        />
      </div>
      <div className="picture-characters" role="radiogroup" aria-label="Characters">
        {CHARACTERS.map((c, i) => (
          <button
            key={c.id}
            role="radio"
            aria-checked={character === i}
            aria-label={c.name}
            title={c.name}
            className={`picture-character${character === i ? " on" : ""}${busy === i ? " busy" : ""}`}
            onClick={() => {
              // The character already on show needs no saving.
              if (character !== i) void change(i, async () => ({ preset: i }), `You are ${c.name} now`);
            }}
            disabled={busy !== null || !me.connection}
          >
            <img src={characterSrc(i)} alt="" width={48} height={48} draggable={false} />
          </button>
        ))}
      </div>
      {problem ? <p className="note down picture-problem">{problem}</p> : null}
    </section>
  );
}
