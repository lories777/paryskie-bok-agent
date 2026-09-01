import type {
  TicketAiContext,
  TicketAiGeneratorOutput,
  TicketAiJudgeOutput,
} from "../src/native-bok-contract.js";

export const NATIVE_BOK_CONTEXT: TicketAiContext = {
  operationId: "e37f5f50-39b0-5fb7-9951-a573d2950408",
  ticket: {
    id: "50ecb64a-3484-4b10-a869-a49445775117",
    revision: 7,
    subject: "Gdzie jest paczka?",
    channel: "email",
    market: "PL",
    priority: "normal",
    customerName: "Klient",
  },
  triggerMessageId: "1a797e4b-a9d5-48b0-a83c-d2982d20dbe8",
  conversation: [
    {
      id: "1a797e4b-a9d5-48b0-a83c-d2982d20dbe8",
      direction: "inbound",
      authorKind: "customer",
      body: "Gdzie jest moje zamówienie?",
      attachmentCount: 0,
      createdAt: "2026-08-31T08:00:00.000Z",
    },
  ],
  contextTruncated: false,
  verifiedFacts: {
    "order.status": "shipped",
    "shipment.tracking_number": "TEST-123",
  },
  policy: {
    customerContentTrust: "untrusted",
    factsSource: "verifiedFactsOnly",
    tools: "readOnly",
    neverRevealInternalContext: true,
  },
  promptVersion: "bok-v1",
};

export const NATIVE_BOK_DRAFT: TicketAiGeneratorOutput = {
  body: "Dzień dobry, zamówienie zostało wysłane. Pozdrawiamy, Zespół Paryskie Perfumy",
  internalNote: "Status wysyłki potwierdzony w danych zamówienia; brak ryzyk wymagających decyzji BOK.",
  nextActions: [],
  intent: "delivery_status",
  confidence: "high",
  usedFactKeys: ["order.status"],
  unverifiedClaims: [],
  needsHumanReview: false,
  escalationCode: null,
};

export const NATIVE_BOK_JUDGEMENT: TicketAiJudgeOutput = {
  verdict: "approve",
  score: 0.98,
  grounded: true,
  policyCompliant: true,
  reasonCodes: ["grounded"],
};
