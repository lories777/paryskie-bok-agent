#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "agent-workspace", "knowledge");
const origin = "https://paryskie.pl";
const userAgent = "Paryskie-BOK-Knowledge/1.0 (+https://paryskie.pl)";

async function fetchJson(url, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return { body: await response.json(), headers: response.headers };
  } catch (error) {
    if (attempt >= 3) throw new Error(`Nie udało się pobrać ${url}: ${String(error)}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    return fetchJson(url, attempt + 1);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAll(endpoint, perPage = 100) {
  const firstUrl = new URL(endpoint, origin);
  firstUrl.searchParams.set("per_page", String(perPage));
  firstUrl.searchParams.set("page", "1");
  const first = await fetchJson(firstUrl);
  const totalPages = Number(first.headers.get("x-wp-totalpages") ?? 1);
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
      return Number.isFinite(number) ? String.fromCodePoint(number) : whole;
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

const [rawProducts, rawCategories, rawPages] = await Promise.all([
  fetchAll("/wp-json/wc/store/v1/products"),
  fetchAll("/wp-json/wc/store/v1/products/categories"),
  fetchAll("/wp-json/wp/v2/pages?_fields=id,slug,link,title,modified,content"),
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

const pages = rawPages.map((page) => ({
  id: page.id,
  slug: page.slug,
  title: decodeHtml(page.title?.rendered ?? ""),
  url: page.link,
  modified: page.modified,
  text: plainText(page.content?.rendered ?? ""),
  links: linksFrom(page.content?.rendered ?? ""),
})).sort((left, right) => left.title.localeCompare(right.title, "pl"));

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
  schema: "paryskie-knowledge-v1",
  refreshedAt,
  origin,
  sources: [
    `${origin}/wp-json/wc/store/v1/products`,
    `${origin}/wp-json/wc/store/v1/products/categories`,
    `${origin}/wp-json/wp/v2/pages`,
  ],
  counts: {
    products: products.length,
    inStockProducts: products.filter((product) => product.inStock).length,
    perfumeNumbers: products.filter((product) => product.perfumeNumber).length,
    categories: categories.length,
    pages: pages.length,
  },
};

const files = {
  "products.jsonl": products.map((product) => JSON.stringify(product)).join("\n") + "\n",
  "categories.json": JSON.stringify(categories, null, 2) + "\n",
  "site-pages.json": JSON.stringify(pages, null, 2) + "\n",
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
for (const [name, content] of Object.entries(files)) {
  const target = path.join(outputDir, name);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

console.log(JSON.stringify(manifest));
