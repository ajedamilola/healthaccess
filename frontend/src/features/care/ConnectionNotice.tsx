"use client";

import { Alert } from "@/components/arc/alert/alert";
import { useOnlineStatus } from "./useOnlineStatus";

/**
 * A persistent banner while the browser is offline, so a failed request is not
 * mistaken for an empty directory. Search entries stay in the form.
 */
export function ConnectionNotice() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <Alert tone="warning" title="You are offline">
      Reconnect to use the directory. Any search entries on this page are kept.
    </Alert>
  );
}
