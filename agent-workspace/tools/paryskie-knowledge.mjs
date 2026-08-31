#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeDir = path.join(workspace, "knowledge");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(knowledgeDir, name), "utf8"));
}

function readProducts() {
  return fs.readFileSync(path.join(knowledgeDir, "products.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function productText(product) {
  return normalize([
    product.perfumeNumber,
    product.sku,
    product.name,
    product.slug,
    ...product.categories.map((category) => category.name),
    ...product.brands,
    ...product.tags,
    ...product.attributes.flatMap((attribute) => [attribute.name, ...attribute.values]),
    product.shortDescription,
    product.description,
  ].filter(Boolean).join(" "));
}

function scoreProduct(product, query) {
  const normalized = normalize(query);
  const tokens = normalized.split(" ").filter(Boolean);
  const text = productText(product);
  const name = normalize(product.name);
  let score = 0;
  if (product.perfumeNumber === query.trim()) score += 100;
  if (normalize(product.sku) === normalized) score += 80;
  if (name === normalized) score += 70;
  if (name.includes(normalized)) score += 35;
  if (text.includes(normalized)) score += 20;
  for (const token of tokens) {
    if (name.includes(token)) score += 8;
    else if (text.includes(token)) score += 3;
    else score -= 5;
  }
  if (product.inStock) score += 2;
  return score;
}

function compactProduct(product) {
  return {
    id: product.id,
    perfumeNumber: product.perfumeNumber,
    sku: product.sku,
    name: product.name,
    price: product.price,
    currency: product.currency,
    onSale: product.onSale,
    inStock: product.inStock,
    stockText: product.stockText,
    categories: product.categories.map((category) => category.name),
    attributes: product.attributes,
    summary: (product.shortDescription || product.description).slice(0, 1_500),
    url: product.url,
  };
}

function usage() {
  console.error("Użycie: paryskie-knowledge.mjs summary | product <numer/SKU/nazwa> | search-products <fraza> [limit] | page <slug> | search-pages <fraza> [limit]");
  process.exitCode = 2;
}

const command = process.argv[2];
const query = process.argv[3]?.trim() ?? "";
const limit = Math.min(Math.max(Number(process.argv[4] ?? 8), 1), 20);

if (command === "summary") {
  console.log(JSON.stringify(readJson("manifest.json"), null, 2));
} else if (command === "product" || command === "search-products") {
  if (!query) usage();
  else {
    const matches = readProducts()
      .map((product) => ({ product, score: scoreProduct(product, query) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || Number(right.product.inStock) - Number(left.product.inStock))
      .slice(0, command === "product" ? 5 : limit)
      .map((item) => compactProduct(item.product));
    console.log(JSON.stringify({ query, count: matches.length, products: matches }, null, 2));
  }
} else if (command === "page" || command === "search-pages") {
  if (!query) usage();
  else {
    const normalized = normalize(query);
    const tokens = normalized.split(" ").filter(Boolean);
    const pages = readJson("site-pages.json")
      .map((page) => {
        const title = normalize(`${page.title} ${page.slug}`);
        const text = normalize(page.text);
        let score = title === normalized ? 100 : title.includes(normalized) ? 50 : text.includes(normalized) ? 20 : 0;
        for (const token of tokens) score += title.includes(token) ? 8 : text.includes(token) ? 2 : -3;
        return { page, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, command === "page" ? 3 : limit)
      .map(({ page }) => ({ ...page, text: page.text.slice(0, 12_000) }));
    console.log(JSON.stringify({ query, count: pages.length, pages }, null, 2));
  }
} else {
  usage();
}
