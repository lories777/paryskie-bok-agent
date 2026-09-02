import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertNativeBokAttachmentEvidenceBound,
  nativeBokAttachmentContentHash,
  nativeBokAttachmentEvidenceHash,
  nativeBokAttachmentEvidenceSchema,
  type NativeBokAttachmentEvidence,
  type NativeBokAttachmentReadReceipt,
} from "./native-bok-attachment-evidence.js";
import {
  NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
  NATIVE_BOK_DECISION_PIPELINE_CONTRACT,
  NATIVE_BOK_DECISION_PIPELINE_HASH,
} from "./native-bok-decision-capability.js";
import type { DaktelaVerifiedSourceRead } from "./daktela-read-session.js";

const PDFINFO = "/usr/bin/pdfinfo";
const PDFTOPPM = "/usr/bin/pdftoppm";
const RENDER_TIMEOUT_MS = 30_000;
const MAX_IMAGE_DIMENSION = 12_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_RENDER_BYTES_PER_PAGE = NATIVE_BOK_DECISION_PIPELINE_CONTRACT.maxAttachmentBytes;
const MAX_RENDER_BYTES_TOTAL = NATIVE_BOK_DECISION_PIPELINE_CONTRACT.maxTotalSourceBytes;

export interface NativeBokRenderedAttachmentEvidence {
  readonly evidence: NativeBokAttachmentEvidence;
  /** Exact ordered images passed unchanged to generator and independent judge. */
  readonly localImagePaths: readonly string[];
  /** Re-hash exact private files immediately before each model boundary. */
  verify(): Promise<void>;
  /** Idempotent removal of every source/render file. Always call in finally. */
  cleanup(): Promise<void>;
}

export interface NativeBokPdfPort {
  available(): boolean;
  inspect(inputPath: string, signal: AbortSignal): Promise<{
    readonly pages: number;
    readonly encrypted: boolean;
  }>;
  render(
    inputPath: string,
    outputPrefix: string,
    pages: number,
    signal: AbortSignal,
  ): Promise<readonly Uint8Array[]>;
}

export class NativeBokAttachmentRenderError extends Error {
  constructor(readonly code:
    | "attachment_renderer_unavailable"
    | "attachment_render_interrupted"
    | "attachment_media_invalid"
    | "attachment_image_limits_exceeded"
    | "attachment_pdf_encrypted"
    | "attachment_pdf_pages_invalid"
    | "attachment_render_limits_exceeded"
    | "attachment_render_failed") {
    super(code);
    this.name = "NativeBokAttachmentRenderError";
  }
}

export class NativeBokAttachmentRenderer {
  constructor(private readonly pdf: NativeBokPdfPort = new PopplerPdfPort()) {}

  ready(): boolean {
    return this.pdf.available();
  }

  async render(
    verified: DaktelaVerifiedSourceRead,
    signal: AbortSignal,
  ): Promise<NativeBokRenderedAttachmentEvidence> {
    if (!this.ready()) {
      throw new NativeBokAttachmentRenderError("attachment_renderer_unavailable");
    }
    assertNotAborted(signal);
    const directory = await mkdtemp(path.join(os.tmpdir(), "bok-daktela-evidence-"));
    await chmod(directory, 0o700);
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true, maxRetries: 2 });
    };

    try {
      const receipts: NativeBokAttachmentReadReceipt[] = [];
      const localImagePaths: string[] = [];
      let renderedBytesTotal = 0;

      for (let attachmentIndex = 0; attachmentIndex < verified.attachments.length; attachmentIndex += 1) {
        assertNotAborted(signal);
        const attachment = verified.attachments[attachmentIndex]!;
        const internalName = `${String(attachmentIndex + 1).padStart(2, "0")}-${randomUUID()}`;
        if (attachment.source.contentType === "image/jpeg") {
          assertJpeg(attachment.bytes);
          renderedBytesTotal = addRenderedBytes(renderedBytesTotal, attachment.bytes.byteLength);
          const outputPath = path.join(directory, `${internalName}.jpg`);
          await writePrivate(outputPath, attachment.bytes);
          const renderHash = sha256(attachment.bytes);
          receipts.push(receipt(attachment.source, "image", [renderHash]));
          localImagePaths.push(outputPath);
          continue;
        }
        if (attachment.source.contentType === "image/png") {
          assertPng(attachment.bytes);
          renderedBytesTotal = addRenderedBytes(renderedBytesTotal, attachment.bytes.byteLength);
          const outputPath = path.join(directory, `${internalName}.png`);
          await writePrivate(outputPath, attachment.bytes);
          const renderHash = sha256(attachment.bytes);
          receipts.push(receipt(attachment.source, "image", [renderHash]));
          localImagePaths.push(outputPath);
          continue;
        }

        assertPdf(attachment.bytes);
        const sourcePath = path.join(directory, `${internalName}.pdf`);
        await writePrivate(sourcePath, attachment.bytes);
        const info = await this.pdf.inspect(sourcePath, signal);
        if (info.encrypted) {
          throw new NativeBokAttachmentRenderError("attachment_pdf_encrypted");
        }
        if (
          !Number.isSafeInteger(info.pages)
          || info.pages < 1
          || info.pages > NATIVE_BOK_DECISION_PIPELINE_CONTRACT.maxPdfPages
        ) {
          throw new NativeBokAttachmentRenderError("attachment_pdf_pages_invalid");
        }
        const rendered = await this.pdf.render(
          sourcePath,
          path.join(directory, `${internalName}-page`),
          info.pages,
          signal,
        );
        if (rendered.length !== info.pages) {
          throw new NativeBokAttachmentRenderError("attachment_render_failed");
        }
        const renderHashes: string[] = [];
        for (let pageIndex = 0; pageIndex < rendered.length; pageIndex += 1) {
          const bytes = rendered[pageIndex]!;
          if (bytes.byteLength > MAX_RENDER_BYTES_PER_PAGE) {
            throw new NativeBokAttachmentRenderError("attachment_render_limits_exceeded");
          }
          assertPng(bytes);
          renderedBytesTotal = addRenderedBytes(renderedBytesTotal, bytes.byteLength);
          const outputPath = path.join(
            directory,
            `${internalName}-page-${String(pageIndex + 1).padStart(2, "0")}.png`,
          );
          await writePrivate(outputPath, bytes);
          renderHashes.push(sha256(bytes));
          localImagePaths.push(outputPath);
        }
        receipts.push(receipt(attachment.source, "pdf", renderHashes));
      }

      const evidenceBase = {
        schemaVersion: 1 as const,
        policyVersion: NATIVE_BOK_ATTACHMENT_POLICY_VERSION,
        pipelineHash: NATIVE_BOK_DECISION_PIPELINE_HASH,
        snapshotHash: verified.source.snapshotHash,
        receipts,
      };
      const evidence = nativeBokAttachmentEvidenceSchema.parse({
        ...evidenceBase,
        evidenceHash: nativeBokAttachmentEvidenceHash(evidenceBase),
      });
      assertNativeBokAttachmentEvidenceBound(verified.source, evidence);
      const expectedRenderHashes = receipts.flatMap((item) => item.renderHashes);
      const verify = async (): Promise<void> => {
        if (cleaned || localImagePaths.length !== expectedRenderHashes.length) {
          throw new NativeBokAttachmentRenderError("attachment_render_failed");
        }
        for (let index = 0; index < localImagePaths.length; index += 1) {
          const bytes = await readFile(localImagePaths[index]!);
          if (sha256(bytes) !== expectedRenderHashes[index]) {
            throw new NativeBokAttachmentRenderError("attachment_render_failed");
          }
        }
      };
      return Object.freeze({
        evidence,
        localImagePaths: Object.freeze(localImagePaths),
        verify,
        cleanup,
      });
    } catch (error) {
      await cleanup();
      if (error instanceof NativeBokAttachmentRenderError) throw error;
      if (signal.aborted) {
        throw new NativeBokAttachmentRenderError("attachment_render_interrupted");
      }
      throw new NativeBokAttachmentRenderError("attachment_render_failed");
    }
  }
}

export class PopplerPdfPort implements NativeBokPdfPort {
  available(): boolean {
    return existsSync(PDFINFO) && existsSync(PDFTOPPM);
  }

  async inspect(inputPath: string, signal: AbortSignal): Promise<{
    readonly pages: number;
    readonly encrypted: boolean;
  }> {
    const stdout = await execute(PDFINFO, [inputPath], signal);
    const pages = Number(stdout.match(/^Pages:\s+(\d+)\s*$/m)?.[1]);
    const encryptedRaw = stdout.match(/^Encrypted:\s+(yes|no)(?:\s|$)/mi)?.[1]?.toLowerCase();
    if (!Number.isSafeInteger(pages) || !encryptedRaw) {
      throw new NativeBokAttachmentRenderError("attachment_render_failed");
    }
    return { pages, encrypted: encryptedRaw === "yes" };
  }

  async render(
    inputPath: string,
    outputPrefix: string,
    pages: number,
    signal: AbortSignal,
  ): Promise<readonly Uint8Array[]> {
    await execute(PDFTOPPM, [
      "-png",
      "-r",
      String(NATIVE_BOK_DECISION_PIPELINE_CONTRACT.pdfRenderDpi),
      "-f",
      "1",
      "-l",
      String(pages),
      inputPath,
      outputPrefix,
    ], signal);
    const directory = path.dirname(outputPrefix);
    const basename = path.basename(outputPrefix);
    const names = (await readdir(directory))
      .filter((name) => name.startsWith(`${basename}-`) && name.endsWith(".png"))
      .sort(naturalPageOrder);
    if (names.length !== pages) {
      throw new NativeBokAttachmentRenderError("attachment_render_failed");
    }
    const exactNames = Array.from({ length: pages }, (_, index) => `${basename}-${index + 1}.png`);
    if (names.some((name, index) => name !== exactNames[index])) {
      throw new NativeBokAttachmentRenderError("attachment_render_failed");
    }
    return Promise.all(names.map((name) => readFile(path.join(directory, name))));
  }
}

function receipt(
  source: DaktelaVerifiedSourceRead["attachments"][number]["source"],
  mediaKind: "image" | "pdf",
  renderHashes: readonly string[],
): NativeBokAttachmentReadReceipt {
  return {
    messageId: source.messageId,
    attachmentId: source.attachmentId,
    externalEventId: source.externalEventId,
    sourceHash: source.sourceHash,
    mediaKind,
    renderHashes: [...renderHashes],
    contentHash: nativeBokAttachmentContentHash({
      mediaKind,
      sourceHash: source.sourceHash,
      renderHashes,
    }),
    status: "read",
  };
}

async function writePrivate(filePath: string, bytes: Uint8Array): Promise<void> {
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
}

function assertPng(bytes: Uint8Array): void {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < 33
    || signature.some((value, index) => bytes[index] !== value)
    || readU32(bytes, 8) !== 13
    || ascii(bytes, 12, 16) !== "IHDR"
  ) {
    throw new NativeBokAttachmentRenderError("attachment_media_invalid");
  }
  assertDimensions(readU32(bytes, 16), readU32(bytes, 20));
}

function assertJpeg(bytes: Uint8Array): void {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new NativeBokAttachmentRenderError("attachment_media_invalid");
  }
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      throw new NativeBokAttachmentRenderError("attachment_media_invalid");
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) {
      throw new NativeBokAttachmentRenderError("attachment_media_invalid");
    }
    if (isSofMarker(marker)) {
      if (length < 7) throw new NativeBokAttachmentRenderError("attachment_media_invalid");
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      assertDimensions(width, height);
      return;
    }
    offset += length;
  }
  throw new NativeBokAttachmentRenderError("attachment_media_invalid");
}

function assertPdf(bytes: Uint8Array): void {
  if (bytes.byteLength < 8 || ascii(bytes, 0, 5) !== "%PDF-") {
    throw new NativeBokAttachmentRenderError("attachment_media_invalid");
  }
}

function assertDimensions(width: number, height: number): void {
  if (
    width < 1
    || height < 1
    || width > MAX_IMAGE_DIMENSION
    || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS
  ) {
    throw new NativeBokAttachmentRenderError("attachment_image_limits_exceeded");
  }
}

function isSofMarker(marker: number): boolean {
  return [
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ].includes(marker);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function addRenderedBytes(current: number, additional: number): number {
  if (additional < 1 || additional > MAX_RENDER_BYTES_PER_PAGE) {
    throw new NativeBokAttachmentRenderError("attachment_render_limits_exceeded");
  }
  const total = current + additional;
  if (total > MAX_RENDER_BYTES_TOTAL) {
    throw new NativeBokAttachmentRenderError("attachment_render_limits_exceeded");
  }
  return total;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new NativeBokAttachmentRenderError("attachment_render_interrupted");
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function naturalPageOrder(left: string, right: string): number {
  const leftPage = Number(left.match(/-(\d+)\.png$/)?.[1]);
  const rightPage = Number(right.match(/-(\d+)\.png$/)?.[1]);
  return leftPage - rightPage;
}

function execute(command: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(new NativeBokAttachmentRenderError("attachment_render_interrupted"));
  }
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      maxBuffer: 64 * 1024,
      timeout: RENDER_TIMEOUT_MS,
      signal,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(signal.aborted
          ? new NativeBokAttachmentRenderError("attachment_render_interrupted")
          : new NativeBokAttachmentRenderError("attachment_render_failed"));
        return;
      }
      resolve(stdout);
    });
  });
}
