import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/api/mocks/server";
import { symptomCreate, symptomList } from "@/api/mocks/fixtures";
import { resetSymptomHandlers, sseResponse, symptomHandlers, tokenFrames } from "@/api/mocks/handlers/symptom";
import { AssistantPage } from "@/features/assistant/AssistantPage";
import { renderWithProviders } from "./utils";

configure({ asyncUtilTimeout: 5000 });

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

const NEW_ID = "ab143840-0058-4486-aa0d-2faf0c88121a";

function composer() {
  return screen.getByLabelText("Describe how you feel…");
}

beforeEach(() => {
  resetSymptomHandlers();
  server.use(...symptomHandlers);
  navigation.push.mockClear();
  navigation.replace.mockClear();
  window.localStorage.clear();
});

describe("AssistantPage", () => {
  it("shows a friendly welcome, the conversation list and the personal context", async () => {
    renderWithProviders(<AssistantPage />);

    expect(screen.getByRole("status", { name: "Loading conversations" })).toBeInTheDocument();
    expect(await screen.findByText("Mild headache and runny nose")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /how are you feeling/i })).toBeInTheDocument();
    expect(await screen.findByText("Personalised for you")).toBeInTheDocument();
    expect(screen.getByText("34 yrs")).toBeInTheDocument();
    expect(screen.getByText("Ikeja")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Long-term conditions/ })).toHaveAttribute("href", "/app/record");
  });

  it("shows an empty sidebar message when there are no chats", async () => {
    server.use(
      http.get("/api/v1/symptom", () => HttpResponse.json({ symptoms: [], page: 1, limit: 10, total: 0, totalPages: 0 })),
    );
    renderWithProviders(<AssistantPage />);
    expect(await screen.findByText("Your chats will appear here.")).toBeInTheDocument();
  });

  it("retries a failed conversation list", async () => {
    let attempts = 0;
    server.use(
      http.get("/api/v1/symptom", () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ error: "upstream_unavailable" }, { status: 500 })
          : HttpResponse.json(symptomList);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AssistantPage />);
    expect(await screen.findByText(/Could not load conversations/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Mild headache and runny nose")).toBeInTheDocument();
  });

  it("streams the reply as it arrives, sends the health record by default and opens the chat", async () => {
    let body: FormData | null = null;
    const reply = symptomCreate.messages[1]!.content;
    server.use(
      http.post("/api/v1/symptom/stream", async ({ request }) => {
        body = await request.formData();
        return sseResponse(
          [
            ["record", { symptom: symptomCreate.symptom }],
            ["step", { id: "s1", name: "searchOnline", status: "started" }],
            ...tokenFrames(reply),
            ["done", symptomCreate],
          ],
          15,
        );
      }),
    );
    renderWithProviders(<AssistantPage />);
    await screen.findByText("Mild headache and runny nose");

    fireEvent.change(composer(), { target: { value: "I have a headache." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("I have a headache.")).toBeInTheDocument();
    expect(await screen.findByText(/Checking trusted health sources/)).toBeInTheDocument();
    // A partial reply is visible before the stream finishes.
    expect(await screen.findByText(/A mild headache with a runny nose/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(`/app/assistant/${NEW_ID}`));
    expect(body!.get("message")).toBe("I have a headache.");
    expect(body!.get("includeRecords")).toBe("true");
    expect(body!.get("modifyHistory")).toBe("true");
    expect(body!.get("language")).toBe("en");
  });

  it("turns the health record off for the chat and remembers it", async () => {
    let body: FormData | null = null;
    server.use(
      http.post("/api/v1/symptom/stream", async ({ request }) => {
        body = await request.formData();
        return sseResponse([["done", symptomCreate]]);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AssistantPage />);
    await screen.findByText("Personalised for you");

    await user.click(screen.getByRole("switch", { name: "Use my health record" }));
    expect(await screen.findByText(/Your health record is off for this chat/)).toBeInTheDocument();
    expect(window.localStorage.getItem("ha.assistant.includeRecords")).toBe("false");

    await user.click(screen.getByRole("button", { name: /My child has a cough/ }));
    await waitFor(() => expect(body?.get("includeRecords")).toBe("false"));
  });

  it("stops a streaming reply", async () => {
    server.use(
      http.post("/api/v1/symptom/stream", () =>
        sseResponse([["record", { symptom: symptomCreate.symptom }], ...tokenFrames("word ".repeat(200))], 20),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<AssistantPage />);
    await screen.findByText("Mild headache and runny nose");
    fireEvent.change(composer(), { target: { value: "I feel unwell." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("shows a friendly error with a retry when the assistant is unavailable", async () => {
    let posts = 0;
    server.use(
      http.post("/api/v1/symptom/stream", () => {
        posts += 1;
        return HttpResponse.json({ error: "ai_unavailable", request_id: "req-503" }, { status: 503 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AssistantPage />);
    await screen.findByText("Mild headache and runny nose");
    fireEvent.change(composer(), { target: { value: "I have a headache." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("The assistant is unavailable right now")).toBeInTheDocument();
    expect(screen.getByText("Request req-503")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts).toBe(2));
  });

  it("explains a timeout may still have saved the message", async () => {
    server.use(
      http.post("/api/v1/symptom/stream", () => HttpResponse.json({ error: "upstream_timeout" }, { status: 504 })),
    );
    renderWithProviders(<AssistantPage />);
    await screen.findByText("Mild headache and runny nose");
    fireEvent.change(composer(), { target: { value: "I have a headache." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("This took too long")).toBeInTheDocument();
    expect(screen.getByText(/may still have been saved/i)).toBeInTheDocument();
  });

  it("shows an error event from the stream", async () => {
    server.use(
      http.post("/api/v1/symptom/stream", () =>
        sseResponse([["error", { error: "ai_invalid_response", message: "raw provider text" }]]),
      ),
    );
    renderWithProviders(<AssistantPage />);
    await screen.findByText("Mild headache and runny nose");
    fireEvent.change(composer(), { target: { value: "I have a headache." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("The assistant could not produce a valid answer. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("raw provider text")).toBeNull();
  });

  it("never sends a message longer than 8,000 characters", async () => {
    let posts = 0;
    server.use(
      http.post("/api/v1/symptom/stream", () => {
        posts += 1;
        return sseResponse([["done", symptomCreate]]);
      }),
    );
    renderWithProviders(<AssistantPage />);
    await screen.findByText("Mild headache and runny nose");
    fireEvent.change(composer(), { target: { value: "a".repeat(8001) } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Keep your message to 8,000 characters or fewer/)).toBeInTheDocument();
    expect(posts).toBe(0);
  });
});

describe("AssistantPage languages", () => {
  // Radix Select uses pointer capture and scrollIntoView, which jsdom lacks.
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });

  it("greets in the profile language and sends the chosen language with a new conversation", async () => {
    const { meMedicalResponse } = await import("@/api/mocks/fixtures");
    let body: FormData | null = null;
    const yoruba = { ...meMedicalResponse, profile: { ...meMedicalResponse.profile, preferred_language: "yo" } };
    server.use(
      http.get("/api/v1/me", () => HttpResponse.json(yoruba)),
      http.post("/api/v1/symptom/stream", async ({ request }) => {
        body = await request.formData();
        return sseResponse([["done", symptomCreate]]);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AssistantPage />);
    expect(await screen.findByText(/bawo ni ara re/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Iba ati ori fifo lati ana/ })).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Ede idahun" }));
    await user.click(await screen.findByRole("option", { name: "Hausa" }));
    expect(await screen.findByText(/yaya jikinka/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Ina da zazzabi/ }));
    await waitFor(() => expect(body?.get("language")).toBe("ha"));
  });
});
