import React, { useEffect, useRef } from "react";
import { BrandMark } from "./BrandMark";
import { Icon } from "./Icon";

export const IntroModal: React.FC<{ onDismiss: () => void }> = ({
  onDismiss,
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="intro-dialog"
      aria-labelledby="intro-title"
      onCancel={onDismiss}
    >
      <div className="intro-brand">
        <BrandMark size={36} />
        <span className="wordmark">ClipBraid</span>
      </div>
      <h1 id="intro-title">
        Your clips.
        <br />
        Your sound.
      </h1>
      <p>
        Bring videos and photos together. Layer your own audio, and choose which
        original sounds stay.
      </p>
      <div
        className="intro-workflow"
        aria-label="Combine visuals and parallel audio"
      >
        <div>
          <Icon name="video" />
          <span>Video clips + photos</span>
        </div>
        <div>
          <Icon name="music" />
          <span>Your music</span>
        </div>
        <div>
          <Icon name="audio" />
          <span>Another audio layer</span>
        </div>
      </div>
      <p className="intro-note">
        Experimental editor. Keep your originals and save your project as you
        work.
      </p>
      <button
        className="button primary intro-start"
        onClick={onDismiss}
        autoFocus
      >
        Start editing
        <Icon name="right" />
      </button>
    </dialog>
  );
};
