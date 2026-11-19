"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Paperclip, Plus, Sparkles, UserRound, X } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { ChatComposer, type ChatDraft } from "@/components/arc/chat-thread/chat-thread";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { useAssistantContext } from "@/api/hooks/record";
import { useSymptoms } from "@/api/hooks/symptom";
import type { ApiError } from "@/api/errors";
import type { SymptomMessage } from "@/api/schemas";
import { AssistantMessage } from "./AssistantMessage";
import { ListenButton } from "./ListenButton";
import { stopSpeech } from "./useSpeech";
import { validateFiles, MAX_MESSAGE } from "./files";
import { normaliseSeverity } from "./format";
import type { PendingTurn, StreamPhase } from "./useAssistantStream";
import styles from "./chat.module.css";
import base from "./assistant.module.css";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((date.getTime() - Date.now()) / 864e5);
  if (days === 0) return "Today";
  if (days > -7) return relative.format(days, "day");
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function ConversationSidebar({
  activeId,
  open,
  onClose,
}: {
  activeId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const symptoms = useSymptoms(page);
  const data = symptoms.data;

  return (
    <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`} aria-label="Your conversations">
      <Link className={styles.newChat} href="/app/assistant" onClick={onClose}>
        <Plus size={16} aria-hidden="true" /> New chat
      </Link>
      <div className={styles.sidebarHead}>
        <h2 className={styles.sidebarTitle}>Recent</h2>
        <button type="button" className={`${styles.iconButton} ${styles.menuToggle}`} onClick={onClose} aria-label="Close list">
          <X size={16} />
        </button>
      </div>
      {symptoms.isLoading ? (
        <Skeleton lines={4} label="Loading conversations" />
      ) : symptoms.isError ? (
        <p className={styles.contextNote}>
          Could not load conversations.{" "}
          <button type="button" className={styles.linkButton} onClick={() => void symptoms.refetch()}>
            Try again
          </button>
        </p>
      ) : data && data.symptoms.length === 0 ? (
        <p className={styles.contextNote}>Your chats will appear here.</p>
      ) : (
        <ul className={styles.conversations}>
          {data?.symptoms.map((symptom) => (
            <li key={symptom.id}>
              <Link
                href={`/app/assistant/${symptom.id}`}
                className={`${styles.conversation} ${symptom.id === activeId ? styles.conversationActive : ""}`}
                aria-current={symptom.id === activeId ? "page" : undefined}
                onClick={onClose}
              >
                <span className={styles.conversationTitle}>
                  <span className={styles.dot} data-severity={normaliseSeverity(symptom.severity) ?? undefined} aria-hidden="true" />
                  <span>{symptom.name || "New conversation"}</span>
                </span>
                <span className={styles.conversationDate}>{relativeDate(symptom.created_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data && data.totalPages > 1 ? (
        <div className={styles.sidebarFoot}>
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
            Newer
          </Button>
          <Button variant="ghost" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>
            Older
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

function Avatar({ user, initial }: { user?: boolean; initial?: string }) {
  return (
    <span className={`${styles.avatar} ${user ? styles.avatarUser : ""}`} aria-hidden="true">
      {user ? initial || <UserRound size={16} /> : <Sparkles size={16} />}
    </span>
  );
}

/** Message list with the live streaming reply. Scrolls to the newest content as tokens arrive. */
export function ChatMessages({
  messages,
  pending,
  reply,
  activity,
  phase,
  userInitial,
  language,
  children,
}: {
  messages: SymptomMessage[];
  pending: PendingTurn | null;
  reply: string;
  activity: string | null;
  phase: StreamPhase;
  userInitial?: string;
  language?: string | null;
  children?: React.ReactNode;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, reply, pending, activity]);

  useEffect(() => stopSpeech, []);

  const streaming = phase === "streaming";
  // While a turn is in flight (or failed), the user's message stays visible even before the server saves it.
  const showPending = pending && (streaming || (phase === "error" && messages.length === 0));

  return (
    <div className={styles.scroller}>
      {children}
      <ol className={styles.messages} aria-label="Conversation messages" aria-live="polite" aria-busy={streaming}>
        {messages.map((message, index) => (
          <li key={`${message.type}-${index}`} className={`${styles.row} ${message.type === "Human" ? styles.rowUser : ""}`}>
            <Avatar user={message.type === "Human"} initial={userInitial} />
            <div className={`${styles.bubble} ${message.type === "Human" ? styles.bubbleUser : ""}`}>
              {message.type === "AI" ? (
                <>
                  <AssistantMessage content={message.content} />
                  <ListenButton id={`reply-${index}`} text={message.content} language={language} />
                </>
              ) : (
                message.content
              )}
            </div>
          </li>
        ))}
        {showPending ? (
          <li className={`${styles.row} ${styles.rowUser}`}>
            <Avatar user initial={userInitial} />
            <div className={`${styles.bubble} ${styles.bubbleUser}`}>
              {pending.message}
              {pending.fileNames.length ? (
                <span className={styles.files}>
                  {pending.fileNames.map((name) => (
                    <span key={name}>
                      <Paperclip size={12} aria-hidden="true" /> {name}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </li>
        ) : null}
        {streaming ? (
          <li className={styles.row}>
            <Avatar />
            <div className={styles.bubble}>
              {reply ? (
                <div className={styles.cursor}>
                  <AssistantMessage content={reply} />
                </div>
              ) : (
                <span className={styles.activity}>
                  <span className={base.dots} aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  {activity ?? "Thinking"}…
                </span>
              )}
            </div>
          </li>
        ) : null}
      </ol>
      <div ref={end} />
    </div>
  );
}

/** Shows what the assistant knows about the person and nudges them to fill the most useful gaps. */
export function ContextCard({ enabled }: { enabled: boolean }) {
  const context = useAssistantContext(enabled);
  if (!enabled) {
    return (
      <div className={styles.context}>
        <p className={styles.contextNote}>
          Your health record is off for this chat. The assistant will ask for details like your age or location if they
          matter.
        </p>
      </div>
    );
  }
  if (context.isLoading) return <Skeleton lines={2} label="Loading your context" />;
  if (!context.data) return null;

  const { snapshot, completeness } = context.data;
  const chips: string[] = [];
  if (snapshot?.ageYears != null) chips.push(`${snapshot.ageYears} yrs`);
  if (snapshot?.sex) chips.push(snapshot.sex);
  if (snapshot?.pregnancyStatus && snapshot.pregnancyStatus !== "Not pregnant") chips.push(snapshot.pregnancyStatus);
  const place = snapshot?.location.city || snapshot?.location.homeArea;
  if (place) chips.push(place);
  if (snapshot?.allergies.length)
    chips.push(`${snapshot.allergies.length} ${snapshot.allergies.length === 1 ? "allergy" : "allergies"}`);
  if (snapshot?.medications.length)
    chips.push(`${snapshot.medications.length} ${snapshot.medications.length === 1 ? "medication" : "medications"}`);
  if (snapshot?.conditions.length)
    chips.push(`${snapshot.conditions.length} ${snapshot.conditions.length === 1 ? "condition" : "conditions"}`);
  if (context.data.language && context.data.language !== "English") chips.push(`Replies in ${context.data.language}`);

  const missing = completeness.missing.slice(0, 3);

  return (
    <div className={styles.context}>
      <div className={styles.contextHead}>
        <span>Personalised for you</span>
        <span className={styles.contextNote}>{completeness.score}% complete</span>
      </div>
      <div className={styles.meter} aria-hidden="true">
        <span style={{ width: `${completeness.score}%` }} />
      </div>
      {chips.length ? (
        <div className={styles.chips} aria-label="Details the assistant will use">
          {chips.map((chip) => (
            <span key={chip} className={styles.chip}>
              {chip}
            </span>
          ))}
        </div>
      ) : (
        <p className={styles.contextNote}>No personal details yet, so answers will be general.</p>
      )}
      {missing.length ? (
        <div className={styles.chips} aria-label="Add details for better answers">
          {missing.map((item) => (
            <Link
              key={item.key}
              href={item.key === "city" || item.key === "gender" ? "/app/profile#about-you" : item.key === "date_of_birth" ? "/app/profile" : "/app/record"}
              className={`${styles.chip} ${styles.chipMissing}`}
              title={item.reason}
            >
              <Plus size={12} aria-hidden="true" /> {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StreamError({
  error,
  onRetry,
  extra,
}: {
  error: ApiError;
  onRetry?: () => void;
  extra?: React.ReactNode;
}) {
  const title =
    error.code === "ai_unavailable"
      ? "The assistant is unavailable right now"
      : error.code === "upstream_timeout" || error.code === "timeout"
        ? "This took too long"
        : "Something went wrong";
  return (
    <Alert tone="danger" title={title}>
      {error.message}
      {error.code === "upstream_timeout" || error.code === "timeout" ? (
        <span> Your message may still have been saved. Check your recent chats before trying again.</span>
      ) : null}
      {error.requestId ? <span className={base.requestId}>Request {error.requestId}</span> : null}
      <span className={styles.inlineActions}>
        {onRetry ? (
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {extra}
      </span>
    </Alert>
  );
}

/** Composer with attachments, validation and a stop button while a reply streams. */
export function ChatInput({
  onSend,
  streaming,
  onStop,
  placeholder,
  footer,
}: {
  onSend: (message: string, files: File[]) => void;
  streaming: boolean;
  onStop: () => void;
  placeholder: string;
  footer?: React.ReactNode;
}) {
  const [problem, setProblem] = useState<string | null>(null);

  function send(draft: ChatDraft) {
    const message = draft.text.trim();
    if (!message) {
      setProblem("Add a short message so the assistant knows what the files are about.");
      return;
    }
    if (message.length > MAX_MESSAGE) {
      setProblem(`Keep your message to ${MAX_MESSAGE.toLocaleString()} characters or fewer.`);
      return;
    }
    const fileError = validateFiles(draft.files);
    if (fileError) {
      setProblem(fileError);
      return;
    }
    setProblem(null);
    onSend(message, draft.files);
  }

  return (
    <div className={styles.composerArea}>
      <div className={styles.composerInner}>
        {problem ? (
          <Alert tone="warning" title="Check your message">
            {problem}
          </Alert>
        ) : null}
        {streaming ? (
          <div className={styles.composerBar}>
            <span>The assistant is replying…</span>
            <Button type="button" size="sm" variant="secondary" onClick={onStop}>
              Stop
            </Button>
          </div>
        ) : null}
        <ChatComposer
          onSend={send}
          placeholder={placeholder}
          allowAttachments
          accept="image/*,application/pdf"
          disabled={streaming}
        />
        <div className={styles.composerBar}>
          {footer ?? <span />}
          <span>General information, not a diagnosis. In an emergency, call your local emergency number.</span>
        </div>
      </div>
    </div>
  );
}
