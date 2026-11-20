"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { History, SlidersHorizontal, Trash2 } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { ApiError, toApiError } from "@/api/errors";
import { useSession } from "@/api/hooks/session";
import { useDeleteSymptom, useSymptom, useUpdateSymptom } from "@/api/hooks/symptom";
import { ChatInput, ChatMessages, ConversationSidebar, StreamError } from "./ChatParts";
import { normaliseSeverity, severityLabel, severityTone, type Severity } from "./format";
import { useAssistantStream } from "./useAssistantStream";
import styles from "./chat.module.css";
import base from "./assistant.module.css";

export function AssistantThread({ id }: { id: string }) {
  const router = useRouter();
  const session = useSession();
  const detail = useSymptom(id);
  const update = useUpdateSymptom(id);
  const remove = useDeleteSymptom(id);
  const stream = useAssistantStream();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [severityDraft, setSeverityDraft] = useState<Severity | null>(null);
  const [status, setStatus] = useState("");
  const [editError, setEditError] = useState<ApiError | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const symptom = detail.data?.symptom;
  const messages = detail.data?.messages ?? [];
  const errorState = detail.error ? toApiError(detail.error) : null;
  const title = titleDraft ?? symptom?.name ?? "";
  const severity = severityDraft ?? normaliseSeverity(symptom?.severity) ?? "";
  const initial = (session.data?.account?.display_name ?? "").trim().charAt(0).toUpperCase();
  const streaming = stream.phase === "streaming";
  const lastHuman = [...messages].reverse().find((message) => message.type === "Human");
  const savedLastAttempt =
    stream.lastRequest?.mode === "followup" &&
    Boolean(lastHuman) &&
    lastHuman?.content.trim() === stream.lastRequest.message.trim();

  async function saveTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTitleError(null);
    setEditError(null);
    const next = title.trim();
    if (!next || next.length > 200) {
      setTitleError(next ? "Keep the title to 200 characters or fewer." : "Enter a title.");
      return;
    }
    try {
      await update.mutateAsync({ name: next });
      setTitleDraft(null);
      setStatus("Title updated.");
    } catch (caught) {
      setEditError(toApiError(caught));
    }
  }

  function changeSeverity(next: string) {
    if (next === severity) return;
    const previous = severity;
    const parsed = normaliseSeverity(next);
    if (!parsed) return;
    setSeverityDraft(parsed);
    setEditError(null);
    update.mutate(
      { severity: parsed },
      {
        onSuccess: () => {
          setSeverityDraft(null);
          setStatus("Severity updated.");
        },
        onError: (caught) => {
          setSeverityDraft(previous || null);
          setEditError(toApiError(caught));
        },
      },
    );
  }

  async function confirmDelete() {
    setEditError(null);
    try {
      await remove.mutateAsync();
      router.push("/app/assistant");
    } catch (caught) {
      setEditError(toApiError(caught));
    }
  }

  const header = (
    <header className={styles.chatHeader}>
      <button
        type="button"
        className={`${styles.iconButton} ${styles.menuToggle}`}
        aria-label="Show conversations"
        onClick={() => setSidebarOpen(true)}
      >
        <History size={18} />
      </button>
      <h1 className={styles.chatTitle}>{symptom?.name || "Conversation"}</h1>
      {symptom ? (
        <>
          <Badge tone={severityTone(symptom.severity)} dot>
            {severityLabel(symptom.severity)}
          </Badge>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Conversation details"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            <SlidersHorizontal size={18} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Delete conversation"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={18} />
          </button>
        </>
      ) : null}
    </header>
  );

  let body: React.ReactNode;
  if (detail.isLoading) {
    body = (
      <div className={styles.scroller}>
        <Skeleton lines={6} label="Loading conversation" />
      </div>
    );
  } else if (errorState || !detail.data) {
    const denied = errorState?.status === 403;
    const missing = errorState?.status === 404;
    body = (
      <div className={styles.scroller}>
        <Alert
          tone={denied || missing ? "warning" : "danger"}
          title={
            denied
              ? "This conversation is not available for this account"
              : missing
                ? "This item is not available"
                : "Could not load this conversation"
          }
        >
          {denied
            ? "A patient profile is required to open symptom conversations. Contact support if you think this is wrong."
            : missing
              ? "It may have been deleted, or it does not exist."
              : errorState?.message}
          {errorState?.requestId ? <span className={base.requestId}>Request {errorState.requestId}</span> : null}
          <span className={styles.inlineActions}>
            <Link href="/app/assistant">Start a new chat</Link>
            {!denied && !missing ? (
              <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
                Try again
              </Button>
            ) : null}
          </span>
        </Alert>
      </div>
    );
  } else {
    body = (
      <>
        {detailsOpen ? (
          <section className={styles.details} aria-labelledby="conversation-details-title">
            <h2 id="conversation-details-title" className={styles.optionTitle}>
              Conversation details
            </h2>
            <form className={styles.detailsRow} onSubmit={saveTitle} noValidate>
              <Input
                label="Title"
                value={title}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={200}
                error={titleError ?? undefined}
                disabled={update.isPending}
              />
              <Button type="submit" variant="secondary" size="sm" loading={update.isPending} disabled={!title.trim()}>
                Save title
              </Button>
            </form>
            <div className={styles.optionCopy}>
              <p className={styles.optionHint}>How serious does this feel now?</p>
              <SegmentedControl
                label="Severity"
                value={severity}
                onValueChange={changeSeverity}
                options={[
                  { value: "MILD", label: "Mild" },
                  { value: "MODERATE", label: "Moderate" },
                  { value: "SEVERE", label: "Severe" },
                ]}
              />
            </div>
            {editError ? (
              <Alert tone="danger" title="Could not save this change">
                {editError.message}
              </Alert>
            ) : null}
            <p className={styles.contextNote} role="status">
              {status}
            </p>
          </section>
        ) : null}

        <ChatMessages
          messages={messages}
          pending={stream.pending}
          reply={stream.reply}
          activity={stream.activity}
          phase={stream.phase}
          userInitial={initial}
          language={symptom?.language}
        >
          {normaliseSeverity(symptom?.severity) === "SEVERE" ? (
            <div className={styles.urgent}>
              <Alert tone="warning" title="This may need urgent care">
                If symptoms are severe or getting worse, call your local emergency number or go to the nearest emergency
                department now. Don&apos;t wait for an online reply.
              </Alert>
            </div>
          ) : null}
        </ChatMessages>

        {stream.phase === "error" && stream.error ? (
          <div className={styles.urgent}>
            <StreamError
              error={stream.error}
              onRetry={
                // If the server already saved this message, retrying would post it twice.
                savedLastAttempt ? undefined : () => void stream.retry()
              }
              extra={
                savedLastAttempt ? (
                  <span>Your message was saved above. Send a new message to continue.</span>
                ) : undefined
              }
            />
          </div>
        ) : null}
        {stream.phase === "cancelled" ? (
          <div className={styles.urgent}>
            <Alert tone="warning" title="Stopped">
              The reply was stopped. Anything already saved is shown above.
            </Alert>
          </div>
        ) : null}

        <ChatInput
          onSend={(message, files) => void stream.start({ mode: "followup", id, message, files })}
          streaming={streaming}
          onStop={stream.cancel}
          placeholder="Reply or ask a follow-up…"
        />
      </>
    );
  }

  return (
    <div className={styles.shell}>
      <ConversationSidebar activeId={id} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <section className={styles.main} aria-label="Conversation">
        {header}
        {body}
      </section>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          title="Delete this conversation?"
          description="This removes the conversation and its attachments. It cannot be undone."
        >
          <div className={base.dialogBody}>
            {editError ? (
              <Alert tone="danger" title="Could not delete this conversation">
                {editError.message}
              </Alert>
            ) : null}
            <div className={base.dialogActions}>
              <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
                Keep conversation
              </Button>
              <Button variant="danger" loading={remove.isPending} onClick={() => void confirmDelete()}>
                Delete conversation
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
