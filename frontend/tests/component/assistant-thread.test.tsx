import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/api/mocks/server";
import { symptomDetail, symptomSevere } from "@/api/mocks/fixtures";
import { resetSymptomHandlers, sseResponse, symptomHandlers, tokenFrames } from "@/api/mocks/handlers/symptom";
import { AssistantThread } from "@/features/assistant/AssistantThread";
import { renderWithProviders } from "./utils";

configure({ asyncUtilTimeout: 5000 });

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

const ID = "ab143840-0058-4486-aa0d-2faf0c88121a";

beforeEach(() => {
  resetSymptomHandlers();
  server.use(...symptomHandlers);
  navigation.push.mockClear();
});

describe("AssistantThread", () => {
  it("renders the saved conversation as chat bubbles with Markdown and the safety copy", async () => {
    renderWithProviders(<AssistantThread id={ID} />);

    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Mild headache and runny nose", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/A mild headache with a runny nose for two days is often due/)).toBeInTheDocument();
    expect(screen.getByText(/General information, not a diagnosis/)).toBeInTheDocument();
    expect(screen.queryByText("This may need urgent care")).toBeNull();
  });

  it("shows urgent-care guidance above the thread for a severe record", async () => {
    server.use(http.get(`/api/v1/symptom/${ID}`, () => HttpResponse.json(symptomSevere)));

    renderWithProviders(<AssistantThread id={ID} />);

    expect(await screen.findByText("This may need urgent care")).toBeInTheDocument();
    expect(screen.getAllByText(/call your local emergency number/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Severe").length).toBeGreaterThan(0);
  });

  it("renames the conversation and changes severity from the details panel", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssistantThread id={ID} />);
    await screen.findByRole("heading", { name: "Mild headache and runny nose", level: 1 });

    await user.click(screen.getByRole("button", { name: "Conversation details" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Headache and runny nose (day 2)" } });
    await user.click(screen.getByRole("button", { name: "Save title" }));

    expect(await screen.findByRole("heading", { name: "Headache and runny nose (day 2)", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Title updated.")).toBeInTheDocument();

    const severity = screen.getByRole("group", { name: "Severity" });
    await user.click(within(severity).getByRole("button", { name: "Severe" }));

    expect(await screen.findByText("Severity updated.")).toBeInTheDocument();
    expect(await screen.findByText("This may need urgent care")).toBeInTheDocument();
  }, 20_000);

  it("streams a follow-up reply into the thread", async () => {
    let body: FormData | null = null;
    const question = "Should I be worried if the headache gets a little worse in the evening?";
    const answer = "A slight increase in the evening **is not necessarily a reason to worry**.";
    server.use(
      http.post(`/api/v1/symptom/${ID}/follow-up/stream`, async ({ request }) => {
        body = await request.formData();
        const messages = [...symptomDetail.messages, { type: "Human", content: question }, { type: "AI", content: answer }];
        return sseResponse(
          [["record", { symptom: symptomDetail.symptom }], ...tokenFrames(answer), ["done", { symptom: symptomDetail.symptom, messages }]],
          10,
        );
      }),
    );
    renderWithProviders(<AssistantThread id={ID} />);
    await screen.findByRole("heading", { name: "Mild headache and runny nose", level: 1 });

    fireEvent.change(screen.getByLabelText("Reply or ask a follow-up…"), { target: { value: question } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(question)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.getByText("is not necessarily a reason to worry")).toBeInTheDocument();
    expect(screen.getAllByText(question)).toHaveLength(1);
    expect(body!.get("message")).toBe(question);
    expect(body!.get("includeRecords")).toBeNull();
  }, 20_000);

  it("stops a streaming follow-up and refetches the thread", async () => {
    let gets = 0;
    server.use(
      http.get(`/api/v1/symptom/${ID}`, () => {
        gets += 1;
        return HttpResponse.json(symptomDetail);
      }),
      http.post(`/api/v1/symptom/${ID}/follow-up/stream`, () => sseResponse(tokenFrames("word ".repeat(200)), 20)),
    );
    const user = userEvent.setup();
    renderWithProviders(<AssistantThread id={ID} />);
    await screen.findByRole("heading", { name: "Mild headache and runny nose", level: 1 });

    fireEvent.change(screen.getByLabelText("Reply or ask a follow-up…"), { target: { value: "Is it getting worse?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    await waitFor(() => expect(gets).toBeGreaterThanOrEqual(2));
  });

  it("keeps the thread visible and offers a retry when the follow-up AI is unavailable", async () => {
    server.use(
      http.post(`/api/v1/symptom/${ID}/follow-up/stream`, () =>
        HttpResponse.json({ error: "ai_unavailable", request_id: "req-ai" }, { status: 503 }),
      ),
    );
    renderWithProviders(<AssistantThread id={ID} />);
    await screen.findByRole("heading", { name: "Mild headache and runny nose", level: 1 });

    fireEvent.change(screen.getByLabelText("Reply or ask a follow-up…"), { target: { value: "Is this urgent?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("The assistant is unavailable right now")).toBeInTheDocument();
    expect(screen.getByText("Request req-ai")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText(/A mild headache with a runny nose/)).toBeInTheDocument();
  });

  it("shows the denied state for a foreign record", async () => {
    server.use(
      http.get(`/api/v1/symptom/${ID}`, () =>
        HttpResponse.json({ error: "forbidden", message: "Forbidden", request_id: "req-denied" }, { status: 403 }),
      ),
    );

    renderWithProviders(<AssistantThread id={ID} />);

    expect(await screen.findByText("This conversation is not available for this account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("uses the generic missing state for a 404", async () => {
    server.use(
      http.get(`/api/v1/symptom/${ID}`, () =>
        HttpResponse.json({ error: "not_found", message: "Symptom analysis record not found" }, { status: 404 }),
      ),
    );

    renderWithProviders(<AssistantThread id={ID} />);

    expect(await screen.findByText("This item is not available")).toBeInTheDocument();
    expect(screen.getByText(/may have been deleted/)).toBeInTheDocument();
  });

  it("deletes the conversation after a confirmation dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssistantThread id={ID} />);
    await screen.findByRole("heading", { name: "Mild headache and runny nose", level: 1 });

    await user.click(screen.getByRole("button", { name: "Delete conversation" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete conversation" }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/app/assistant"));
  });
});

describe("AssistantThread retry after a partly saved follow-up", () => {
  it("does not offer Try again when the server already saved the message", async () => {
    const question = "Is it getting worse?";
    server.use(
      http.post(`/api/v1/symptom/${ID}/follow-up/stream`, () =>
        sseResponse([["token", { content: "Partial" }], ["error", { error: "stream_error" }]]),
      ),
      http.get(`/api/v1/symptom/${ID}`, () =>
        HttpResponse.json({
          ...symptomDetail,
          messages: [...symptomDetail.messages, { type: "Human", content: question }],
        }),
      ),
    );
    renderWithProviders(<AssistantThread id={ID} />);
    await screen.findByRole("heading", { name: "Mild headache and runny nose", level: 1 });
    fireEvent.change(screen.getByLabelText("Reply or ask a follow-up…"), { target: { value: question } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Your message was saved above/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
