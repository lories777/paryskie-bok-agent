import assert from "node:assert/strict";
import test from "node:test";
import { bezPodpisuCzatu } from "../src/native-bok-inference.js";

test("czat: odcina pożegnanie i podpis zespołu z końca (przykłady z produkcji 13.10)", () => {
  assert.equal(
    bezPodpisuCzatu("Dzień dobry,\n\nPropozycję współpracy może Pani zgłosić przez formularz.\n\nPozdrawiamy,\nZespół Paryskie Perfumy"),
    "Dzień dobry,\n\nPropozycję współpracy może Pani zgłosić przez formularz.",
  );
  assert.equal(
    bezPodpisuCzatu("Kérjük, küldje el a csomagkövetési számot. Üdvözlettel: A Párizsi Parfümök csapata"),
    "Kérjük, küldje el a csomagkövetési számot. Üdvözlettel: A Párizsi Parfümök csapata",
    "pożegnanie w tej samej linii co treść zostaje — nie tniemy zdań",
  );
  assert.equal(bezPodpisuCzatu("Jó napot!\nMegnézzük a rendelést.\nÜdvözlettel:\nA Párizsi Parfümök csapata"), "Jó napot!\nMegnézzük a rendelést.");
  assert.equal(bezPodpisuCzatu("Dobrý den, objednávka je na cestě.\nS pozdravem,\ntým Paryskie Perfumy"), "Dobrý den, objednávka je na cestě.");
});

test("czat: bez pożegnania albo gdy zostałby pusty tekst — bez zmian", () => {
  assert.equal(bezPodpisuCzatu("Dobrý den, jak vám můžeme pomoci?"), "Dobrý den, jak vám můžeme pomoci?");
  assert.equal(bezPodpisuCzatu("Pozdrawiamy serdecznie!"), "Pozdrawiamy serdecznie!");
  assert.equal(bezPodpisuCzatu("Dzień dobry!\nPozdrawiamy mamę z okazji urodzin.\nCzy mogę jeszcze w czymś pomóc?"),
    "Dzień dobry!\nPozdrawiamy mamę z okazji urodzin.\nCzy mogę jeszcze w czymś pomóc?",
    "pożegnanie tylko w ostatnich 3 liniach i tylko jako osobna linia formuły");
});
