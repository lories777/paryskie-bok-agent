import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildParyskieRecommendationContext } from "../src/paryskie-knowledge.js";
import type { StoredMessage } from "../src/types.js";

test("prośba o prostą rekomendację dostaje zweryfikowane, dostępne bestsellery", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bok-knowledge-"));
  fs.mkdirSync(path.join(workspace, "knowledge"));
  const product = (number: string, inStock: boolean, categories: string[]) => ({
    perfumeNumber: number,
    sku: `${number}P`,
    name: `N° ${number}`,
    price: 39.9,
    currency: "PLN",
    inStock,
    stockText: inStock ? "Na stanie" : "Brak",
    categories: categories.map((name) => ({ name })),
    attributes: [
      { name: "Nazwa oryginał", values: ["Good Girl"] },
      { name: "Typ zapachu", values: ["orientalny", "słodki"] },
      { name: "Intensywność", values: ["Mocne"] },
      { name: "Nuty głowy", values: ["Kawa", "Migdały"] },
    ],
    description: "Jeden z najczęściej wybieranych zapachów damskich.",
    url: `https://paryskie.test/${number}`,
  });
  fs.writeFileSync(
    path.join(workspace, "knowledge", "products.jsonl"),
    [
      product("340", true, ["Paris Perfumes", "Damskie", "Bestsellery"]),
      product("999", false, ["Paris Perfumes", "Damskie", "Bestsellery"]),
      product("100", true, ["Paris Perfumes", "Męskie", "Bestsellery"]),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  const messages: StoredMessage[] = [{
    id: 1,
    conversationId: 1,
    role: "human",
    authorId: "bok",
    authorName: "BOK",
    content: "Klientka się nie zna, prosi po prostu o polecenie damskich perfum.",
    createdAt: "2026-08-26T20:00:00.000Z",
  }];

  try {
    const context = buildParyskieRecommendationContext(workspace, messages) ?? "";
    assert.match(context, /ZWERYFIKOWANE DANE LOKALNE/);
    assert.match(context, /"number":"340"/);
    assert.match(context, /"bestseller":true/);
    assert.doesNotMatch(context, /"number":"999"/);
    assert.doesNotMatch(context, /"number":"100"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("zwykła sprawa bez rekomendacji nie ładuje katalogu do promptu", () => {
  const context = buildParyskieRecommendationContext("/nieistniejący", [{
    id: 1,
    conversationId: 1,
    role: "human",
    authorId: "bok",
    authorName: "BOK",
    content: "Sprawdź status zamówienia.",
    createdAt: "2026-08-26T20:00:00.000Z",
  }]);
  assert.equal(context, undefined);
});

test("pytanie o konkretny numer dostaje płeć i charakter zapachu z katalogu", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bok-knowledge-product-"));
  fs.mkdirSync(path.join(workspace, "knowledge"));
  fs.writeFileSync(path.join(workspace, "knowledge", "products.jsonl"), `${JSON.stringify({
    perfumeNumber: "608",
    sku: "608P",
    name: "N° 608",
    price: 49.9,
    currency: "PLN",
    inStock: true,
    categories: [{ name: "Paris Perfumes" }, { name: "Damskie" }, { name: "Męskie" }, { name: "Unisex" }],
    attributes: [
      { name: "Nazwa oryginał", values: ["Baccarat Rouge 540"] },
      { name: "Płeć", values: ["Damskie", "Męskie", "unisex"] },
      { name: "Typ zapachu", values: ["drzewny", "słodki"] },
      { name: "Nuty głowy", values: ["Jaśmin", "Szafran"] },
    ],
  })}\n`);
  const messages: StoredMessage[] = [{
    id: 1,
    conversationId: 1,
    role: "context",
    authorId: "daktela-monitor",
    authorName: "Monitor Daktela",
    content: "Biztosan N° 608-at rendeltem? Férfi illatnak tűnik.",
    createdAt: "2026-08-31T08:00:00.000Z",
  }];
  try {
    const context = buildParyskieRecommendationContext(workspace, messages) ?? "";
    assert.match(context, /ZWERYFIKOWANE DANE LOKALNE/);
    assert.match(context, /"number":"608"/);
    assert.match(context, /"gender":\["Damskie","Męskie","unisex"\]/);
    assert.match(context, /Baccarat Rouge 540/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("nagłówek polecenie runtime nie jest prośbą klienta o polecenie perfum", () => {
  const context = buildParyskieRecommendationContext("/nieistniejący", [{
    id: 2,
    conversationId: 1,
    role: "context",
    authorId: "daktela-monitor",
    authorName: "Monitor Daktela",
    content: `[AUTOMATYCZNE ZADANIE DAKTELA — polecenie runtime]
      <customer_history><customer_activity index="1" direction="incoming">
      Masz nową reklamację produktu N°553. Otwórz szczegóły w Allegro.
      </customer_activity></customer_history>`,
    createdAt: "2026-08-29T14:00:00.000Z",
  }]);
  assert.equal(context, undefined);
});

test("nazwana marka ma pierwszeństwo przed niepasującym bestsellerem", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bok-knowledge-brand-"));
  fs.mkdirSync(path.join(workspace, "knowledge"));
  const product = (number: string, inspiration: string, description: string) => ({
    perfumeNumber: number,
    sku: `${number}P`,
    name: `N° ${number}`,
    price: 49.9,
    currency: "PLN",
    inStock: true,
    stockText: "Na stanie",
    categories: ["Paris Perfumes", "Damskie", "Bestsellery"].map((name) => ({ name })),
    attributes: [
      { name: "Nazwa oryginał", values: [inspiration] },
      { name: "Intensywność", values: ["Wyraźne"] },
    ],
    description,
  });
  fs.writeFileSync(
    path.join(workspace, "knowledge", "products.jsonl"),
    [
      product("340", "Good Girl", "Bestseller inspirowany Carolina Herrera Good Girl."),
      product("652", "Paradoxe", "Trwały odpowiednik Prada Paradoxe."),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  const messages: StoredMessage[] = [{
    id: 1,
    conversationId: 1,
    role: "context",
    authorId: "daktela-monitor",
    authorName: "Monitor Daktela",
    content: "Jeśli macie Prada perfum, to poproszę lub według własnego uznania, oby długo pachniały.",
    createdAt: "2026-08-27T10:00:00.000Z",
  }];

  try {
    const context = buildParyskieRecommendationContext(workspace, messages) ?? "";
    assert.match(context, /NAMED_CATALOG_MATCH number=652 terms=prada/);
    assert.match(context, /"number":"652"/);
    assert.ok(context.indexOf('"number":"652"') < context.indexOf('"number":"340"'));
    assert.match(context, /"query_match_terms":\["prada"\]/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("stara rekomendacja nie miesza się z najnowszą nazwą marki", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bok-knowledge-history-"));
  fs.mkdirSync(path.join(workspace, "knowledge"));
  const product = (number: string, inspiration: string, description: string) => ({
    perfumeNumber: number,
    sku: `${number}P`,
    name: `N° ${number}`,
    inStock: true,
    categories: ["Paris Perfumes", "Damskie", "Bestsellery"].map((name) => ({ name })),
    attributes: [{ name: "Nazwa oryginał", values: [inspiration] }],
    description,
  });
  fs.writeFileSync(path.join(workspace, "knowledge", "products.jsonl"), `${[
    product("340", "Good Girl", "Carolina Herrera Good Girl"),
    product("652", "Paradoxe", "Prada Paradoxe"),
  ].map((item) => JSON.stringify(item)).join("\n")}\n`);
  const messages: StoredMessage[] = [{
    id: 1,
    conversationId: 1,
    role: "human",
    authorId: "bok",
    authorName: "BOK",
    content: "Wcześniej poleć klientce Good Girl.",
    createdAt: "2026-08-27T09:00:00.000Z",
  }, {
    id: 2,
    conversationId: 1,
    role: "human",
    authorId: "bok",
    authorName: "BOK",
    content: "Teraz wybierz klientce perfumy Prada według własnego uznania.",
    createdAt: "2026-08-27T10:00:00.000Z",
  }];
  try {
    const context = buildParyskieRecommendationContext(workspace, messages) ?? "";
    assert.match(context, /NAMED_CATALOG_MATCH number=652 terms=prada/);
    assert.doesNotMatch(context, /NAMED_CATALOG_MATCH number=340/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("wyszukanie nazwanej marki skaluje się liniowo na pełnym katalogu", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "paryskie-knowledge-perf-"));
  const knowledge = path.join(workspace, "knowledge");
  fs.mkdirSync(knowledge, { recursive: true });
  const products = Array.from({ length: 750 }, (_, index) => ({
    perfumeNumber: String(index + 1),
    sku: `${index + 1}P`,
    name: `N° ${index + 1}`,
    inStock: true,
    categories: [{ name: "Paris Perfumes" }, { name: "Damskie" }, { name: "Bestsellery" }],
    attributes: [{ name: "Nazwa oryginał", values: [index === 651 ? "Prada Paradoxe" : `Zapach ${index}`] }],
    description: "kwiatowy zapach na co dzień z wanilią i jaśminem",
  }));
  fs.writeFileSync(path.join(knowledge, "products.jsonl"), `${products.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const messages: StoredMessage[] = [{
    id: 1,
    conversationId: 1,
    role: "human",
    authorId: "bok",
    authorName: "BOK",
    content: "Wybierz klientce perfumy Prada według naszego uznania.",
    createdAt: "2026-08-27T10:00:00.000Z",
  }];
  try {
    const startedAt = performance.now();
    const context = buildParyskieRecommendationContext(workspace, messages) ?? "";
    assert.ok(performance.now() - startedAt < 1_000);
    assert.match(context, /NAMED_CATALOG_MATCH number=652 terms=prada/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
