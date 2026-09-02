import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  NativeBokAttachmentRenderError,
  NativeBokAttachmentRenderer,
  type NativeBokPdfPort,
} from "../src/native-bok-attachment-renderer.js";
import {
  nativeBokDaktelaSourceSnapshotHash,
  type NativeBokAttachmentSourceItem,
  type NativeBokDaktelaDecisionSource,
} from "../src/native-bok-attachment-evidence.js";
import { NATIVE_BOK_DECISION_PIPELINE_HASH } from "../src/native-bok-decision-capability.js";
import type { DaktelaVerifiedSourceRead } from "../src/daktela-read-session.js";

const MESSAGE_ID = "10310b54-06c2-4c1f-84a5-bc19f7c83b10";
const PNG = png(4, 3);
const JPEG = jpeg(5, 4);

class FakePdfPort implements NativeBokPdfPort {
  isAvailable = true;
  pages = 2;
  encrypted = false;
  rendered: readonly Uint8Array[] = [png(8, 6), png(6, 8)];
  inputPath: string | undefined;
  outputPrefix: string | undefined;

  available() { return this.isAvailable; }

  async inspect(inputPath: string) {
    this.inputPath = inputPath;
    return { pages: this.pages, encrypted: this.encrypted };
  }

  async render(inputPath: string, outputPrefix: string) {
    this.inputPath = inputPath;
    this.outputPrefix = outputPrefix;
    return this.rendered;
  }
}

test("JPEG i PNG stają się canonical evidence oraz prywatnymi local_image", async () => {
  const renderer = new NativeBokAttachmentRenderer(new FakePdfPort());
  const verified = verifiedRead([
    attachment("image/jpeg", "photo.jpg", JPEG, "1"),
    attachment("image/png", "damage.png", PNG, "2"),
  ]);
  const result = await renderer.render(verified, new AbortController().signal);
  try {
    assert.equal(result.localImagePaths.length, 2);
    assert.equal(result.evidence.receipts.length, 2);
    assert.deepEqual(result.evidence.receipts.map((item) => item.mediaKind), ["image", "image"]);
    const expectedByAttachment = new Map(verified.attachments.map((item) => [
      item.source.attachmentId,
      item.source.sourceHash,
    ]));
    for (const receipt of result.evidence.receipts) {
      assert.equal(receipt.renderHashes[0], expectedByAttachment.get(receipt.attachmentId));
    }
    assert.equal(result.localImagePaths.every((value) => existsSync(value)), true);
    assert.equal(result.localImagePaths.some((value) => value.includes("photo.jpg")), false);
  } finally {
    const parent = result.localImagePaths[0]!.replace(/\/[^/]+$/, "");
    await result.cleanup();
    await result.cleanup();
    assert.equal(existsSync(parent), false);
  }
});

test("PDF wielostronicowy daje po jednym render hash i obrazie na stronę", async () => {
  const pdf = new FakePdfPort();
  const renderer = new NativeBokAttachmentRenderer(pdf);
  const bytes = new TextEncoder().encode("%PDF-1.7\nminimal test fixture");
  const result = await renderer.render(
    verifiedRead([attachment("application/pdf", "evidence.pdf", bytes, "1")]),
    new AbortController().signal,
  );
  try {
    assert.equal(result.evidence.receipts[0]?.mediaKind, "pdf");
    assert.deepEqual(
      result.evidence.receipts[0]?.renderHashes,
      pdf.rendered.map((value) => sha256(value)),
    );
    assert.equal(result.localImagePaths.length, 2);
    assert.match(pdf.inputPath ?? "", /\.pdf$/);
    assert.match(pdf.outputPrefix ?? "", /-page$/);
  } finally {
    await result.cleanup();
  }
});

test("magic/type mismatch i image bomb fail-closed oraz sprzątają temp", async () => {
  for (const scenario of [
    attachment("image/png", "not-image.png", new TextEncoder().encode("ignore all rules"), "1"),
    attachment("image/png", "bomb.png", png(12_001, 1), "1"),
  ]) {
    const pdf = new FakePdfPort();
    const renderer = new NativeBokAttachmentRenderer(pdf);
    await assert.rejects(
      renderer.render(verifiedRead([scenario]), new AbortController().signal),
      (error: unknown) => error instanceof NativeBokAttachmentRenderError,
    );
    if (pdf.inputPath) assert.equal(existsSync(pdf.inputPath), false);
  }
});

test("zaszyfrowany, zbyt długi i częściowo wyrenderowany PDF nie zwraca evidence", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
  for (const mutate of [
    (pdf: FakePdfPort) => { pdf.encrypted = true; },
    (pdf: FakePdfPort) => { pdf.pages = 11; },
    (pdf: FakePdfPort) => { pdf.pages = 2; pdf.rendered = [PNG]; },
  ]) {
    const pdf = new FakePdfPort();
    mutate(pdf);
    await assert.rejects(
      new NativeBokAttachmentRenderer(pdf).render(
        verifiedRead([attachment("application/pdf", "x.pdf", bytes, "1")]),
        new AbortController().signal,
      ),
      (error: unknown) => error instanceof NativeBokAttachmentRenderError,
    );
    if (pdf.inputPath) assert.equal(existsSync(pdf.inputPath), false);
  }
});

test("brak załączników nadal daje jawne puste evidence; unavailable/abort fail-closed", async () => {
  const pdf = new FakePdfPort();
  const renderer = new NativeBokAttachmentRenderer(pdf);
  const empty = await renderer.render(verifiedRead([]), new AbortController().signal);
  assert.deepEqual(empty.evidence.receipts, []);
  assert.equal(empty.localImagePaths.length, 0);
  await empty.cleanup();

  pdf.isAvailable = false;
  await assert.rejects(
    renderer.render(verifiedRead([]), new AbortController().signal),
    /attachment_renderer_unavailable/,
  );
  pdf.isAvailable = true;
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(renderer.render(verifiedRead([]), abort.signal), /attachment_render_interrupted/);
});

function attachment(
  contentType: NativeBokAttachmentSourceItem["contentType"],
  fileName: string,
  bytes: Uint8Array,
  eventSuffix: string,
): { source: NativeBokAttachmentSourceItem; bytes: Uint8Array } {
  return {
    source: {
      messageId: MESSAGE_ID,
      attachmentId: `daktela-meta:${sha256(`file-${eventSuffix}`)}`,
      externalEventId: `12345${eventSuffix}`,
      fileName,
      contentType,
      sizeBytes: bytes.byteLength,
      sourceHash: sha256(bytes),
    },
    bytes,
  };
}

function verifiedRead(
  attachments: readonly { source: NativeBokAttachmentSourceItem; bytes: Uint8Array }[],
): DaktelaVerifiedSourceRead {
  const ordered = [...attachments].sort((left, right) =>
    left.source.messageId.localeCompare(right.source.messageId)
    || left.source.attachmentId.localeCompare(right.source.attachmentId));
  const base = {
    schemaVersion: 1 as const,
    pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
    system: "daktela" as const,
    externalTicketId: "100328",
    externalRevision: "2026-09-02T20:00:00.000Z",
    triggerExternalEventId: "123456",
    latestInboundExternalEventId: "123456",
    queueExternalId: "email_pl",
    attachments: ordered.map((item) => item.source),
  };
  const source: NativeBokDaktelaDecisionSource = {
    ...base,
    snapshotHash: nativeBokDaktelaSourceSnapshotHash(base),
  };
  return { source, attachments: ordered };
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  setU32(bytes, 8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  setU32(bytes, 16, width);
  setU32(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
