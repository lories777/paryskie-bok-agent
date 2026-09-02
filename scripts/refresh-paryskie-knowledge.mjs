#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = process.env.PARYSKIE_KNOWLEDGE_OUTPUT_DIR
  ? path.resolve(process.env.PARYSKIE_KNOWLEDGE_OUTPUT_DIR)
  : path.join(repoRoot, "agent-workspace", "knowledge");
const origin = "https://paryskie.pl";
const userAgent = "Paryskie-BOK-Knowledge/1.0 (+https://paryskie.pl)";
const maxJsonResponseBytes = 25 * 1024 * 1024;
const maxTextResponseBytes = 5 * 1024 * 1024;
const maxSitemaps = 32;
const maxSitemapUrls = 5_000;
const maxRenderedFetches = 250;
const maxRenderedDocumentChars = 100_000;
const maxLinksPerDocument = 500;

async function fetchJson(url, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxJsonResponseBytes) {
      throw new Error(`Odpowiedź JSON przekracza limit ${maxJsonResponseBytes} B`);
    }
    const rawBody = await response.text();
    if (Buffer.byteLength(rawBody, "utf8") > maxJsonResponseBytes) {
      throw new Error(`Odpowiedź JSON przekracza limit ${maxJsonResponseBytes} B`);
    }
    return { body: JSON.parse(rawBody), headers: response.headers };
  } catch (error) {
    if (attempt >= 3) throw new Error(`Nie udało się pobrać ${url}: ${String(error)}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    return fetchJson(url, attempt + 1);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "text/html,application/xml,text/xml" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxTextResponseBytes) {
      throw new Error(`Odpowiedź przekracza limit ${maxTextResponseBytes} B`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxTextResponseBytes) {
      throw new Error(`Odpowiedź przekracza limit ${maxTextResponseBytes} B`);
    }
    return body;
  } catch (error) {
    if (attempt >= 3) throw new Error(`Nie udało się pobrać ${url}: ${String(error)}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    return fetchText(url, attempt + 1);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextResult(url) {
  try {
    return { ok: true, body: await fetchText(url) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchAll(endpoint, perPage = 100) {
  const firstUrl = new URL(endpoint, origin);
  firstUrl.searchParams.set("per_page", String(perPage));
  firstUrl.searchParams.set("page", "1");
  const first = await fetchJson(firstUrl);
  const totalPages = Number(first.headers.get("x-wp-totalpages") ?? 1);
  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 200) {
    throw new Error(`Nieprawidłowa liczba stron API dla ${endpoint}: ${totalPages}`);
  }
  const rows = [...first.body];
  for (let page = 2; page <= totalPages; page += 1) {
    const url = new URL(firstUrl);
    url.searchParams.set("page", String(page));
    const result = await fetchJson(url);
    rows.push(...result.body);
  }
  return rows;
}

function decodeHtml(value = "") {
  const named = new Map([
    ["amp", "&"], ["quot", '"'], ["apos", "'"], ["lt", "<"], ["gt", ">"],
    ["nbsp", " "], ["ndash", "–"], ["mdash", "—"], ["hellip", "…"],
    ["rsquo", "’"], ["lsquo", "‘"], ["rdquo", "”"], ["ldquo", "“"],
    ["deg", "°"], ["times", "×"],
  ]);
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    if (entity.startsWith("#")) {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      const validCodePoint = Number.isInteger(number) && number >= 0 && number <= 0x10ffff &&
        !(number >= 0xd800 && number <= 0xdfff);
      return validCodePoint ? String.fromCodePoint(number) : whole;
    }
    return named.get(entity.toLowerCase()) ?? whole;
  });
}

function plainText(html = "") {
  return decodeHtml(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:p|div|section|article|h[1-6]|li|ul|ol|br|tr|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function renderedContent(html = "") {
  return html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0] ?? html;
}

function renderedText(html = "") {
  return plainText(renderedContent(html)).slice(0, maxRenderedDocumentChars);
}

function linksFrom(html = "") {
  const links = [];
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(decodeHtml(match[1] ?? ""), origin);
      if (["http:", "https:"].includes(url.protocol)) links.push(url.toString());
    } catch {}
  }
  return [...new Set(links)];
}

function normalizePublicUrl(value) {
  const url = new URL(value, origin);
  url.hash = "";
  url.search = "";
  if (url.origin !== origin) throw new Error(`URL spoza paryskie.pl w sitemapie: ${value}`);
  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeHtml(match[1] ?? "").trim())
    .filter(Boolean);
}

function sitemapEntries(xml) {
  return [...xml.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/gi)].map((match) => {
    const block = match[1] ?? "";
    const location = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    if (!location) throw new Error("Wpis sitemapy bez loc");
    return {
      url: normalizePublicUrl(decodeHtml(location.trim())),
      modified: block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1]?.trim() ?? null,
    };
  });
}

async function fetchPublicSitemap() {
  const indexUrl = new URL("/wp-sitemap.xml", origin).toString();
  const index = await fetchText(indexUrl);
  const sitemapUrls = sitemapLocations(index).map((url) => normalizePublicUrl(url));
  if (sitemapUrls.length === 0) throw new Error("Publiczna sitemapa nie zawiera podmap");
  if (sitemapUrls.length > maxSitemaps) {
    throw new Error(`Publiczna sitemapa przekracza limit ${maxSitemaps} podmap`);
  }
  const maps = await Promise.all(sitemapUrls.map(async (url) => ({
    url,
    body: await fetchText(url),
  })));
  const entries = new Map();
  for (const map of maps) {
    for (const entry of sitemapEntries(map.body)) entries.set(entry.url, entry);
  }
  if (entries.size === 0) throw new Error("Publiczna sitemapa nie zawiera adresów");
  if (entries.size > maxSitemapUrls) {
    throw new Error(`Publiczna sitemapa przekracza limit ${maxSitemapUrls} adresów`);
  }
  return { indexUrl, sitemapUrls, entries: [...entries.values()] };
}

async function mapConcurrent(values, concurrency, mapper) {
  const result = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      result[index] = await mapper(values[index], index);
    }
  }));
  return result;
}

function titleFromHtml(html, fallback) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return plainText(title ?? "") || fallback;
}

function price(product) {
  const raw = product.prices?.price;
  const minor = product.prices?.currency_minor_unit ?? 2;
  if (raw === null || raw === undefined || !/^\d+$/.test(String(raw))) return null;
  return Number(raw) / (10 ** minor);
}

function perfumeNumber(product) {
  const text = `${product.name ?? ""} ${product.slug ?? ""} ${product.sku ?? ""}`;
  return text.match(/(?:N[°ºo]|NR)\s*[-_.]?\s*(\d{1,4})\b/i)?.[1] ?? null;
}

const [rawProducts, rawCategories, rawPages, rawPosts, publicSitemap] = await Promise.all([
  fetchAll("/wp-json/wc/store/v1/products"),
  fetchAll("/wp-json/wc/store/v1/products/categories"),
  fetchAll("/wp-json/wp/v2/pages?_fields=id,slug,link,title,modified,content"),
  fetchAll("/wp-json/wp/v2/posts?_fields=id,slug,link,title,modified,content"),
  fetchPublicSitemap(),
]);

const products = rawProducts.map((product) => ({
  id: product.id,
  perfumeNumber: perfumeNumber(product),
  sku: decodeHtml(product.sku ?? ""),
  name: decodeHtml(product.name ?? ""),
  slug: product.slug,
  url: product.permalink,
  type: product.type,
  price: price(product),
  currency: product.prices?.currency_code ?? "PLN",
  regularPrice: product.prices?.regular_price
    ? Number(product.prices.regular_price) / (10 ** (product.prices.currency_minor_unit ?? 2))
    : null,
  onSale: Boolean(product.on_sale),
  inStock: Boolean(product.is_in_stock),
  stockText: plainText(product.stock_availability?.text ?? ""),
  purchasable: Boolean(product.is_purchasable),
  categories: (product.categories ?? []).map((category) => ({
    id: category.id,
    name: decodeHtml(category.name ?? ""),
    slug: category.slug,
  })),
  brands: (product.brands ?? []).map((brand) => decodeHtml(brand.name ?? "")),
  tags: (product.tags ?? []).map((tag) => decodeHtml(tag.name ?? "")),
  attributes: (product.attributes ?? []).map((attribute) => ({
    name: decodeHtml(attribute.name ?? ""),
    values: (attribute.terms ?? []).map((term) => decodeHtml(term.name ?? "")),
  })),
  shortDescription: plainText(product.short_description ?? ""),
  description: plainText(product.description ?? ""),
  image: product.images?.[0]?.src ?? null,
  updatedFrom: "WooCommerce Store API",
})).sort((left, right) => left.name.localeCompare(right.name, "pl"));

const categories = rawCategories.map((category) => ({
  id: category.id,
  name: decodeHtml(category.name ?? ""),
  slug: category.slug,
  description: plainText(category.description ?? ""),
  parent: category.parent,
  count: category.count,
  url: category.permalink,
})).sort((left, right) => left.name.localeCompare(right.name, "pl"));

const sitemapByUrl = new Map(publicSitemap.entries.map((entry) => [entry.url, entry]));
const publishedPageUrls = new Set(sitemapByUrl.keys());
const emptyPublishedPages = rawPages.filter((page) => {
  const url = normalizePublicUrl(page.link);
  return publishedPageUrls.has(url) && !plainText(page.content?.rendered ?? "");
});
if (emptyPublishedPages.length > maxRenderedFetches) {
  throw new Error(`Renderowane fallbacki przekraczają limit ${maxRenderedFetches} stron`);
}
const renderedEmptyPageResults = new Map((await mapConcurrent(emptyPublishedPages, 8, async (page) => {
  const url = normalizePublicUrl(page.link);
  return [url, await fetchTextResult(url)];
})).map((entry) => entry));
const renderedEmptyPageFailures = [...renderedEmptyPageResults.values()]
  .filter((result) => !result.ok).length;

const pages = rawPages.map((page) => {
  const url = normalizePublicUrl(page.link);
  const renderedResult = renderedEmptyPageResults.get(url);
  const renderedHtml = renderedResult?.ok ? renderedResult.body : undefined;
  return ({
  id: page.id,
  kind: "page",
  slug: page.slug,
  title: decodeHtml(page.title?.rendered ?? ""),
  url,
  modified: page.modified,
  text: renderedHtml ? renderedText(renderedHtml) : plainText(page.content?.rendered ?? ""),
  links: linksFrom(renderedHtml ? renderedContent(renderedHtml) : page.content?.rendered ?? "")
    .slice(0, maxLinksPerDocument),
  contentSource: renderedHtml ? "rendered-html" : "WordPress REST API",
  });
});

const posts = rawPosts.map((post) => ({
  id: post.id,
  kind: "post",
  slug: post.slug,
  title: decodeHtml(post.title?.rendered ?? ""),
  url: normalizePublicUrl(post.link),
  modified: post.modified,
  text: plainText(post.content?.rendered ?? ""),
  links: linksFrom(post.content?.rendered ?? "").slice(0, maxLinksPerDocument),
  contentSource: "WordPress REST API",
}));

const structuredUrls = new Set([
  ...products.map((product) => normalizePublicUrl(product.url)),
  ...categories.map((category) => normalizePublicUrl(category.url)),
  ...pages.map((page) => page.url),
  ...posts.map((post) => post.url),
]);
const supplementalEntries = publicSitemap.entries.filter((entry) => !structuredUrls.has(entry.url));
if (emptyPublishedPages.length + supplementalEntries.length > maxRenderedFetches) {
  throw new Error(`Łączny crawl HTML przekracza limit ${maxRenderedFetches} stron`);
}
const supplementalResults = await mapConcurrent(supplementalEntries, 8, async (entry, index) => {
  const result = await fetchTextResult(entry.url);
  if (!result.ok) return { entry, error: result.error };
  const html = result.body;
  const slug = new URL(entry.url).pathname.split("/").filter(Boolean).at(-1) ?? "strona-glowna";
  return { entry, page: {
    id: `sitemap-${index + 1}`,
    kind: "sitemap-page",
    slug,
    title: titleFromHtml(html, slug),
    url: entry.url,
    modified: entry.modified,
    text: renderedText(html),
    links: linksFrom(renderedContent(html)).slice(0, maxLinksPerDocument),
    contentSource: "rendered-html",
  } };
});
const supplementalPages = supplementalResults.flatMap((result) => result.page ? [result.page] : []);
const sitemapGaps = supplementalResults.flatMap((result) => result.page ? [] : [{
  url: result.entry.url,
  reason: result.error,
}]);

const siteDocuments = [...pages, ...posts, ...supplementalPages]
  .sort((left, right) => left.title.localeCompare(right.title, "pl"));

const importantPageSlugs = [
  "zwroty-reklamacje",
  "dostawa-koszty-i-czas",
  "kontakt",
  "regulamin",
  "formularz-odstapienia-od-umowy",
  "program-lojalnosciowy",
  "program-lojalnosciowy-regulamin",
  "aktualne-promocje",
  "o-nas",
];
const importantPages = importantPageSlugs
  .map((slug) => pages.find((page) => page.slug === slug))
  .filter(Boolean);
const refreshedAt = new Date().toISOString();

const manifest = {
  schema: "paryskie-knowledge-v2",
  refreshedAt,
  origin,
  sources: [
    `${origin}/wp-json/wc/store/v1/products`,
    `${origin}/wp-json/wc/store/v1/products/categories`,
    `${origin}/wp-json/wp/v2/pages`,
    `${origin}/wp-json/wp/v2/posts`,
    publicSitemap.indexUrl,
    ...publicSitemap.sitemapUrls,
  ],
  counts: {
    products: products.length,
    inStockProducts: products.filter((product) => product.inStock).length,
    perfumeNumbers: products.filter((product) => product.perfumeNumber).length,
    categories: categories.length,
    pages: pages.length,
    posts: posts.length,
    renderedPageFallbacks: renderedEmptyPageResults.size - renderedEmptyPageFailures,
    renderedPageFallbackFailures: renderedEmptyPageFailures,
    renderedSitemapSupplements: supplementalPages.length,
    sitemapUrls: publicSitemap.entries.length,
    sitemapUrlsCovered: publicSitemap.entries.length - sitemapGaps.length,
    sitemapUrlsMissing: sitemapGaps.length,
  },
  sitemapGaps,
};

const files = {
  "products.jsonl": products.map((product) => JSON.stringify(product)).join("\n") + "\n",
  "categories.json": JSON.stringify(categories, null, 2) + "\n",
  "site-pages.json": JSON.stringify(siteDocuments, null, 2) + "\n",
  "policies.md": [
    "# Aktualna wiedza publiczna Paryskie.pl",
    "",
    `Odświeżono: ${refreshedAt}`,
    "",
    "Dedykowana strona procesu lub regulamin ma pierwszeństwo przed ogólnym FAQ. Ceny, dostępność",
    "i promocje są danymi zmiennymi — przed odpowiedzią zależną od bieżącego stanu sprawdź stronę.",
    "",
    ...importantPages.flatMap((page) => [
      `## ${page.title}`,
      "",
      `Źródło: ${page.url}`,
      `Aktualizacja źródła: ${page.modified}`,
      "",
      page.text,
      "",
      ...(page.links.length ? ["Linki:", ...page.links.map((url) => `- ${url}`), ""] : []),
    ]),
  ].join("\n"),
  "manifest.json": "",
};
manifest.sha256 = Object.fromEntries(Object.entries(files)
  .filter(([name]) => name !== "manifest.json")
  .map(([name, content]) => [name, crypto.createHash("sha256").update(content).digest("hex")]));
files["manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
// Manifest jest publikowany jako ostatni. Czytelnicy weryfikują jego hashe, więc przerwany refresh
// kończy się jawnym błędem spójności zamiast użyciem mieszanki starego i nowego snapshotu.
for (const [name, content] of Object.entries(files)) {
  const target = path.join(outputDir, name);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

console.log(JSON.stringify(manifest));
