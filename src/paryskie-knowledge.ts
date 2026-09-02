import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StoredMessage } from "./types.js";

interface KnowledgeProduct {
  perfumeNumber?: string | null;
  sku?: string;
  name?: string;
  price?: number | null;
  currency?: string;
  inStock?: boolean;
  stockText?: string;
  categories?: Array<{ name?: string }>;
  attributes?: Array<{ name?: string; values?: string[] }>;
  shortDescription?: string;
  description?: string;
  url?: string;
}

interface CatalogCache {
  file: string;
  modifiedMs: number;
  manifestModifiedMs: number | null;
  products: KnowledgeProduct[];
}

interface ProductMatchIndex {
  normalizedQuery: string;
  queryTokens: string[];
  productTexts: Map<KnowledgeProduct, string>;
  documentFrequency: Map<string, number>;
}

let cache: CatalogCache | undefined;

const RECOMMENDATION_INTENT =
  /\b(?:polec|rekomend|dob(?:ierz|or)|wybierz|wedlug\s+(?:wlasnego|pani|pana)\s+uznania|jakie?\s+(?:perfum|zapach)|najlepsz\w*\s+(?:perfum|zapach)|perfum\w*\s+(?:damsk|męsk|mesk|unisex)|zapach\w*\s+(?:damsk|męsk|mesk|unisex))\w*/iu;

const GENERIC_QUERY_TERMS = new Set([
  "agent", "daktela", "ticket", "klient", "klientka", "perfum", "perfumy", "zapach",
  "zapachu", "wymiana", "wymiane", "zamowienie", "odpowiedz", "wiadomosc", "formularz",
  "prosze", "poprosze", "wedlug", "wlasnego", "uznania", "ladnie", "dlugo", "pachnialy",
]);

/**
 * Host-side, read-only catalog evidence. It does not depend on a nested shell sandbox, so the
 * agent and reviewer receive the same product facts even when the Codex subprocess cannot start
 * another bubblewrap namespace inside the systemd service.
 */
export function buildParyskieRecommendationContext(
  workspacePath: string,
  messages: StoredMessage[],
): string | undefined {
  const relevantMessages = messages
    .slice(-6)
    .filter((message) => message.role === "human" || message.authorId === "daktela-monitor");
  const recommendationMessage = [...relevantMessages]
    .reverse()
    .map((message) => ({ message, intentText: recommendationIntentText(message) }))
    .find(({ intentText }) => RECOMMENDATION_INTENT.test(normalize(intentText)));
  const latestMessage = relevantMessages.at(-1) ?? messages.at(-1);
  const latestIntentText = latestMessage ? recommendationIntentText(latestMessage) : "";
  const referenceIntentText = [...relevantMessages]
    .reverse()
    .map(recommendationIntentText)
    .find((value) => !isAutomaticNotification(value) && /\bN\s*[°ºo]?\s*\d{1,4}\b/iu.test(value))
    ?? latestIntentText;
  const referencedNumbers = isAutomaticNotification(referenceIntentText)
    ? []
    : [...referenceIntentText.matchAll(/\bN\s*[°ºo]?\s*(\d{1,4})\b/giu)]
      .map((match) => match[1]!)
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 6);
  if (!recommendationMessage && referencedNumbers.length === 0) return undefined;
  const humanText = recommendationMessage?.intentText ?? referenceIntentText;

  try {
    if (!recommendationMessage) {
      const referenced = readProducts(workspacePath)
        .filter((product) => referencedNumbers.includes(product.perfumeNumber?.trim() ?? ""))
        .filter((product) => product.sku === `${product.perfumeNumber}P`)
        .slice(0, 6);
      if (referenced.length === 0) return undefined;
      const matchIndex = buildProductMatchIndex(referenced, humanText);
      return [
        "Paryskie katalog: ZWERYFIKOWANE DANE LOKALNE z ostatniego automatycznego odświeżenia.",
        "To są fakty o konkretnych numerach N° wymienionych w bieżącej wiadomości. Użyj ich do odpowiedzi o płci, inspiracji, nutach, charakterze i aktualnej dostępności produktu.",
        JSON.stringify({ products: referenced.map((product) => compactProduct(product, matchIndex)) }),
      ].join("\n").slice(0, 16_000);
    }
    const standardProducts = readProducts(workspacePath).filter(isStandardPerfume);
    const matchIndex = buildProductMatchIndex(standardProducts, humanText);
    const queryMatches = standardProducts
      .map((product) => ({
        product,
        score: productScore(product, matchIndex),
        terms: distinctiveMatchingTerms(product, matchIndex),
      }))
      .filter(({ score }) => score > 10)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
    const bestsellers = standardProducts
      .filter((product) => categories(product).includes("bestsellery"))
      .sort((left, right) => popularityScore(right) - popularityScore(left))
      .slice(0, 12);
    const selected = deduplicate([...queryMatches.map(({ product }) => product), ...bestsellers]).slice(0, 12);
    if (selected.length === 0) return undefined;

    const namedMatches = queryMatches.filter(({ terms }) => terms.length > 0);

    return [
      "Paryskie katalog: ZWERYFIKOWANE DANE LOKALNE z ostatniego automatycznego odświeżenia.",
      "Poniższe produkty mają inStock=true, są damskimi perfumami Paris Perfumes i należą do kategorii Bestsellery albo pasują do pytania.",
      "Kategoria Bestsellery potwierdza, że produkt wolno przedstawić jako bestseller; nie wymyślaj kolejności sprzedaży.",
      ...(namedMatches.length > 0
        ? [
            "Klient nazwał markę, oryginał lub linię zapachu. Dopasowanie nazwane ma pierwszeństwo przed ogólnym bestsellerem; nie zastępuj go produktem innej marki.",
            "Produkty poza NAMED_CATALOG_MATCH są tylko opcjonalnymi alternatywami i nie stanowią sprzecznych danych o wyborze klienta.",
            "<catalog_named_matches>",
            ...namedMatches.map(({ product, terms }) =>
              `NAMED_CATALOG_MATCH number=${product.perfumeNumber} terms=${terms.join(",")}`
            ),
            "</catalog_named_matches>",
          ]
        : []),
      JSON.stringify({ products: selected.map((product) => compactProduct(product, matchIndex)) }),
    ].join("\n").slice(0, 30_000);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Paryskie katalog: ERROR — ${detail.slice(0, 300)}`;
  }
}

function isAutomaticNotification(value: string): boolean {
  const normalized = normalize(value);
  return /(?:masz nowa reklamacje|wiadomosc zostala wyslana automatycznie|nie odpowiadaj na te wiadomosc)/.test(normalized);
}

function recommendationIntentText(message: StoredMessage): string {
  if (message.role === "human") return message.content;
  const histories = [...message.content.matchAll(
    /<customer_history\b[^>]*>([\s\S]*?)<\/customer_history>/gi,
  )].map((match) => match[1] ?? "").filter(Boolean);
  return histories.length > 0 ? histories.join("\n") : message.content;
}

function readProducts(workspacePath: string): KnowledgeProduct[] {
  const file = path.join(workspacePath, "knowledge", "products.jsonl");
  const manifestFile = path.join(workspacePath, "knowledge", "manifest.json");
  const modifiedMs = fs.statSync(file).mtimeMs;
  const manifestModifiedMs = fs.existsSync(manifestFile) ? fs.statSync(manifestFile).mtimeMs : null;
  if (
    cache?.file === file && cache.modifiedMs === modifiedMs &&
    cache.manifestModifiedMs === manifestModifiedMs
  ) return cache.products;
  const content = fs.readFileSync(file, "utf8");
  if (manifestModifiedMs !== null) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      sha256?: Record<string, unknown>;
    };
    const expected = manifest.sha256?.["products.jsonl"];
    const actual = createHash("sha256").update(content).digest("hex");
    if (typeof expected !== "string" || expected !== actual) {
      throw new Error("Niespójny snapshot wiedzy: products.jsonl");
    }
  }
  const products = content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as KnowledgeProduct);
  cache = { file, modifiedMs, manifestModifiedMs, products };
  return products;
}

function isStandardPerfume(product: KnowledgeProduct): boolean {
  const perfumeNumber = product.perfumeNumber?.trim();
  if (!perfumeNumber || product.inStock !== true || product.sku !== `${perfumeNumber}P`) return false;
  const names = categories(product);
  return names.includes("paris perfumes") && names.includes("damskie");
}

function categories(product: KnowledgeProduct): string[] {
  return (product.categories ?? []).map((category) => normalize(category.name ?? ""));
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[łŁ]/g, "l")
    .toLocaleLowerCase("pl-PL")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function productText(product: KnowledgeProduct): string {
  return normalize([
    product.perfumeNumber,
    product.sku,
    product.name,
    ...(product.categories ?? []).map((category) => category.name),
    ...(product.attributes ?? []).flatMap((attribute) => [attribute.name, ...(attribute.values ?? [])]),
    product.shortDescription,
    product.description,
  ].filter(Boolean).join(" "));
}

function productScore(
  product: KnowledgeProduct,
  index: ProductMatchIndex,
): number {
  const text = index.productTexts.get(product) ?? productText(product);
  let score = categories(product).includes("bestsellery") ? 5 : 0;
  if (product.perfumeNumber && new RegExp(`\\b${product.perfumeNumber}\\b`).test(index.normalizedQuery)) {
    score += 100;
  }
  const inspiration = product.attributes?.find(
    (attribute) => normalize(attribute.name ?? "") === "nazwa oryginal",
  )?.values?.[0];
  for (const exactName of [product.name, inspiration]) {
    const normalizedName = normalize(exactName ?? "");
    if (normalizedName.length >= 4 && index.normalizedQuery.includes(normalizedName)) score += 50;
  }
  for (const token of index.queryTokens) {
    if (!text.includes(token)) continue;
    const documentFrequency = index.documentFrequency.get(token) ?? 0;
    score += documentFrequency <= 3 ? 40 : documentFrequency <= 20 ? 15 : 2;
  }
  return score;
}

function distinctiveMatchingTerms(
  product: KnowledgeProduct,
  index: ProductMatchIndex,
): string[] {
  const text = index.productTexts.get(product) ?? productText(product);
  return index.queryTokens.filter((token) => {
    if (GENERIC_QUERY_TERMS.has(token)) return false;
    if (!text.includes(token)) return false;
    return (index.documentFrequency.get(token) ?? 0) <= 20;
  }).slice(0, 8);
}

function buildProductMatchIndex(
  products: KnowledgeProduct[],
  query: string,
): ProductMatchIndex {
  const normalizedQuery = normalize(query);
  const queryTokens = [...new Set(normalizedQuery.split(" "))]
    .filter((token) => token.length >= 4);
  const productTexts = new Map(products.map((product) => [product, productText(product)]));
  const documentFrequency = new Map(queryTokens.map((token) => [
    token,
    [...productTexts.values()].filter((text) => text.includes(token)).length,
  ]));
  return { normalizedQuery, queryTokens, productTexts, documentFrequency };
}

function popularityScore(product: KnowledgeProduct): number {
  const description = normalize(`${product.shortDescription ?? ""} ${product.description ?? ""}`);
  return 1 + (/najczesciej wybier|najpopularniejs|bestseller/.test(description) ? 10 : 0);
}

function deduplicate(products: KnowledgeProduct[]): KnowledgeProduct[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = product.perfumeNumber ?? product.sku ?? product.name ?? "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactProduct(
  product: KnowledgeProduct,
  matchIndex: ProductMatchIndex,
): Record<string, unknown> {
  const attributes = Object.fromEntries(
    (product.attributes ?? [])
      .filter((attribute) => attribute.name && attribute.values?.length)
      .map((attribute) => [attribute.name!, attribute.values]),
  );
  return {
    number: product.perfumeNumber,
    sku: product.sku,
    name: product.name,
    inspiration: attributes["Nazwa oryginał"] ?? null,
    query_match_terms: distinctiveMatchingTerms(product, matchIndex),
    price_from: product.price,
    currency: product.currency,
    in_stock: product.inStock,
    stock_text: product.stockText,
    bestseller: categories(product).includes("bestsellery"),
    gender: attributes.Płeć ?? null,
    intensity: attributes.Intensywność ?? null,
    scent_type: attributes["Typ zapachu"] ?? null,
    top_notes: attributes["Nuty głowy"] ?? null,
    heart_notes: attributes["Nuty serca"] ?? null,
    base_notes: attributes["Nuty bazy"] ?? null,
    occasions: attributes.Okoliczność ?? null,
    seasons: attributes["Pora Roku"] ?? null,
    url: product.url,
  };
}
