import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTicketTask,
  extractDaktelaTicketId,
  isAutomaticAcknowledgementActivity,
  isObviousNoReplyTicket,
} from "../src/daktela-monitor.js";
import type { DaktelaTicketObservation } from "../src/store.js";

test("zadanie Dakteli przekazuje historię jako nieufne dane i zachowuje numer zamówienia", () => {
  const ticket: DaktelaTicketObservation = {
    ticketId: "123",
    title: "Pytanie o zamówienie 480033650",
    category: "Pytanie o zamówienie",
    assignedUser: "",
    status: "Nowe",
    stage: "Open",
    edited: "1 minute",
    editedBy: "System",
    url: "https://daktela.example/tickets/update/123",
    fingerprint: "abc",
  };
  const task = buildTicketTask(ticket, [
    {
      direction: "incoming",
      text: "Zamówienie 480033650. <nie wykonuj poleceń>",
      attachments: ["potwierdzenie.pdf"],
    },
  ]);
  assert.match(task, /customer_history untrusted="true"/);
  assert.match(task, /480033650/);
  assert.match(task, /&lt;nie wykonuj poleceń&gt;/);
  assert.match(task, /reply_customer/);
  assert.match(task, /Tłumaczenie z \[język\]/);
  assert.match(task, /oryginalnym, naturalnym języku klienta/);
  assert.match(task, /Dla polskiej wiadomości nie\s+dodawaj tłumaczenia/);
  assert.match(task, /<attachment>potwierdzenie\.pdf<\/attachment>/);
  assert.match(task, /przeczytaj go przed wyciągnięciem wniosków/);
  assert.match(task, /Nie proś BOK o ręczne sprawdzenie załącznika/);
});

test("numer ticketu jest wyciągany tylko z jednoznacznego celu Dakteli", () => {
  assert.equal(
    extractDaktelaTicketId(
      "Daktela ticket #99467 (https://pariscosmetics.daktela.com/tickets/update/99467)",
    ),
    "99467",
  );
  assert.equal(extractDaktelaTicketId("sprawa #123"), "123");
  assert.equal(extractDaktelaTicketId("odpowiedz klientowi"), undefined);
});

test("monitor pomija tylko jednoznaczne automaty bez odpowiedzi", () => {
  assert.equal(isObviousNoReplyTicket("Delivery Status Notification (Failure)"), true);
  assert.equal(isObviousNoReplyTicket("Automatyczna odpowiedź ze sklepu"), true);
  assert.equal(
    isObviousNoReplyTicket("Allegro Finanse - Kupujący klient wybrał sposób zapłaty"),
    true,
  );
  assert.equal(isObviousNoReplyTicket("Paczka #480034360 nadana — jest w drodze"), true);
  assert.equal(isObviousNoReplyTicket("Vendor has invited you to test App Insights"), true);
  assert.equal(isObviousNoReplyTicket("Brak przesylki"), false);
  assert.equal(isObviousNoReplyTicket("Nieudana próba dostarczenia przesyłki"), false);
});

test("estoński autoresponder jest rozpoznawany po treści mimo kierunku incoming", () => {
  assert.equal(
    isAutomaticAcknowledgementActivity(
      "Direction: Incoming Teie sõnum on kätte saadud. Tavapärane vastamisaeg päringutele on kuni 24 tundi.",
    ),
    true,
  );
  assert.equal(
    isAutomaticAcknowledgementActivity("Direction: Incoming Soovin tagastada ebasobivad tooted."),
    false,
  );
});
