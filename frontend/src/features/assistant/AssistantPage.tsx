"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { History, Settings2, Sparkles } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Switch } from "@/components/arc/switch/switch";
import { useSession } from "@/api/hooks/session";
import { useMe } from "@/api/hooks/record";
import { Select } from "@/components/arc/select/select";
import { ASSISTANT_LANGUAGES, assistantCopy, assistantLocale, type AssistantLocale } from "./i18n";
import { ChatInput, ChatMessages, ContextCard, ConversationSidebar, StreamError } from "./ChatParts";
import { useAssistantStream } from "./useAssistantStream";
import styles from "./chat.module.css";

const RECORDS_KEY = "ha.assistant.includeRecords";

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(RECORDS_KEY) !== "false";
  } catch {
    return true;
  }
}

function subscribeNoop() {
  return () => undefined;
}

function writePreference(value: boolean) {
  try {
    window.localStorage.setItem(RECORDS_KEY, String(value));
  } catch {
    // Remembering the choice is a convenience only.
  }
}

function firstName(displayName: string | null | undefined) {
  return (displayName ?? "").trim().split(/\s+/)[0] ?? "";
}

export function AssistantPage() {
  const router = useRouter();
  const session = useSession();
  const stream = useAssistantStream();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const stored = useSyncExternalStore(subscribeNoop, readPreference, () => true);
  const [override, setIncludeRecords] = useState<boolean | null>(null);
  const includeRecords = override ?? stored;
  const [modifyHistory, setModifyHistory] = useState(true);
  const [languageChoice, setLanguageChoice] = useState<AssistantLocale | null>(null);

  const name = firstName(session.data?.account?.display_name);
  const me = useMe();
  const language = languageChoice ?? assistantLocale(me.data?.profile.preferred_language);
  const text = assistantCopy(language);
  const streaming = stream.phase === "streaming";
  const active = stream.phase !== "idle" || Boolean(stream.pending);

  function toggleRecords(value: boolean) {
    setIncludeRecords(value);
    writePreference(value);
  }

  async function send(message: string, files: File[]) {
    const done = await stream.start({
      mode: "create",
      message,
      files,
      includeRecords,
      modifyHistory,
      language,
    });
    if (done) router.replace(`/app/assistant/${done.symptom.id}`);
  }

  return (
    <div className={styles.shell}>
      <ConversationSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <section className={styles.main} aria-label="New conversation">
        <header className={styles.chatHeader}>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.menuToggle}`}
            aria-label="Show conversations"
            onClick={() => setSidebarOpen(true)}
          >
            <History size={18} />
          </button>
          <h1 className={styles.chatTitle}>Health assistant</h1>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Chat settings"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((value) => !value)}
          >
            <Settings2 size={18} />
          </button>
        </header>

        {optionsOpen ? (
          <div className={styles.details}>
            <div className={styles.option}>
              <div className={styles.optionCopy}>
                <p className={styles.optionTitle} id="opt-records">
                  Use my health record
                </p>
                <p className={styles.optionHint} id="opt-records-hint">
                  Lets the assistant tailor advice to your age, location, allergies and medicines. Codes and phone numbers
                  are never sent.
                </p>
              </div>
              <Switch
                checked={includeRecords}
                onCheckedChange={toggleRecords}
                aria-labelledby="opt-records"
                aria-describedby="opt-records-hint"
              />
            </div>
            <div className={styles.option}>
              <div className={styles.optionCopy}>
                <p className={styles.optionTitle} id="opt-history">
                  Name and rate this chat for me
                </p>
                <p className={styles.optionHint} id="opt-history-hint">
                  The assistant gives the chat a short title and a severity you can change later.
                </p>
              </div>
              <Switch
                checked={modifyHistory}
                onCheckedChange={setModifyHistory}
                aria-labelledby="opt-history"
                aria-describedby="opt-history-hint"
              />
            </div>
          </div>
        ) : null}

        <ChatMessages
          messages={[]}
          pending={stream.pending}
          reply={stream.reply}
          activity={stream.activity}
          phase={stream.phase}
          userInitial={name.charAt(0).toUpperCase()}
          language={language}
        >
          {!active ? (
            <div className={styles.welcome}>
              <span className={styles.welcomeIcon} aria-hidden="true">
                <Sparkles size={24} />
              </span>
              <h2 className={styles.greeting}>{text.greeting(name)}</h2>
              <p className={styles.lead}>{text.lead}</p>
              <div className={styles.languagePick}>
                <Select
                  label={text.languageLabel}
                  description={text.languageHint}
                  options={[...ASSISTANT_LANGUAGES]}
                  value={language}
                  onValueChange={(value) => setLanguageChoice(assistantLocale(value))}
                />
              </div>
              <ContextCard enabled={includeRecords} />
              <div className={styles.suggestions}>
                {text.suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" className={styles.suggestion} onClick={() => void send(suggestion, [])}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </ChatMessages>

        {stream.phase === "error" && stream.error ? (
          <div className={styles.urgent}>
            <StreamError
              error={stream.error}
              onRetry={stream.symptomId ? undefined : () => void stream.retry()}
              extra={
                stream.symptomId ? (
                  <Link href={`/app/assistant/${stream.symptomId}`}>Open this conversation</Link>
                ) : (
                  <Button size="sm" variant="ghost" onClick={stream.reset}>
                    Start over
                  </Button>
                )
              }
            />
          </div>
        ) : null}

        {stream.phase === "cancelled" ? (
          <div className={styles.urgent}>
            <Alert tone="warning" title="Stopped">
              The reply was stopped. If part of it was saved, it is in your recent chats.
              <span className={styles.inlineActions}>
                <Button size="sm" variant="secondary" onClick={stream.reset}>
                  New message
                </Button>
              </span>
            </Alert>
          </div>
        ) : null}

        <ChatInput
          onSend={(message, files) => void send(message, files)}
          streaming={streaming}
          onStop={stream.cancel}
          placeholder={text.placeholder}
          footer={
            <label className={styles.toggleInline}>
              <Switch checked={includeRecords} onCheckedChange={toggleRecords} aria-label="Use my health record" />
              {includeRecords ? "Using your health record" : "Health record off"}
            </label>
          }
        />
      </section>
    </div>
  );
}
