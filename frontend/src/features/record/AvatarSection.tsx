"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/arc/alert/alert";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import { FileDropzone } from "@/components/arc/file-dropzone/file-dropzone";
import { toApiError } from "@/api/errors";
import { useUploadAvatar } from "@/api/hooks/record";
import { qk } from "@/api/keys";
import type { MeResponse } from "@/api/schemas";
import { isUpstreamTimeout } from "./helpers";
import { FormError, RequestId, StatusLine } from "./States";
import styles from "./record.module.css";

const MAX_BYTES = 5 * 1024 * 1024;

export function AvatarSection({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const upload = useUploadAvatar();
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageRequestId, setStorageRequestId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState(0);

  // The upload success path is gated until object storage is available in the environment.
  if (process.env.NEXT_PUBLIC_AVATAR_UPLOAD !== "1") return null;

  const name = me.account.display_name ?? me.account.email;

  async function submit() {
    setFormError(null);
    setStorageError(null);
    setStorageRequestId(undefined);
    setStatus(null);
    if (!file) {
      setStorageError("Choose an image first.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setStorageError("Choose an image file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setStorageError("Choose an image up to 5 MB.");
      return;
    }

    try {
      await upload.mutateAsync(file);
      setFile(null);
      setDropKey((key) => key + 1);
      setStatus("Profile photo updated.");
    } catch (error) {
      const apiError = toApiError(error);
      if (isUpstreamTimeout(error)) {
        // The upload may have landed. Read the current profile before showing a retry.
        await queryClient.refetchQueries({ queryKey: qk.me });
        setFormError(error);
        return;
      }
      if (apiError.code === "storage_unavailable") {
        setStorageError("File storage is unavailable right now. Other profile changes still work.");
        setStorageRequestId(apiError.requestId);
        return;
      }
      setFormError(error);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="avatar-title">
      <div className={styles.sectionCopy}>
        <h2 id="avatar-title" className={styles.sectionTitle}>
          Profile photo
        </h2>
        <p className={styles.sectionNote}>
          An optional photo for your account. It is not shown in an emergency summary or shared with a lookup.
        </p>
      </div>

      <div className={styles.avatarRow}>
        <Avatar name={name} src={me.avatar_url ?? undefined} size="xl" />
        <div className={styles.avatarCopy}>
          <p className={styles.note}>
            {me.avatar_url ? "Current photo" : "No photo yet. Your initials are shown."}
          </p>
        </div>
      </div>

      {formError ? <FormError error={formError} onRetry={() => void submit()} /> : null}

      {storageError ? (
        <Alert tone="danger" title="Could not upload this photo">
          <span>
            {storageError}
            <RequestId id={storageRequestId} />
          </span>
        </Alert>
      ) : null}

      <FileDropzone
        key={dropKey}
        accept="image/*"
        multiple={false}
        maxFiles={1}
        maxSize={MAX_BYTES}
        onFilesChange={(files) => {
          setFile(files[0] ?? null);
          setStorageError(null);
          setStatus(null);
        }}
        label="Choose a profile photo"
        description="Drop an image here or choose from your device"
        note="Image file up to 5 MB"
      />

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          loading={upload.isPending}
          disabled={upload.isPending || !file}
          onClick={() => void submit()}
        >
          Upload photo
        </Button>
        <StatusLine>{status}</StatusLine>
      </div>
    </section>
  );
}
