import { fileURLToPath } from 'node:url';
import { renderPageAsImage, type getDocumentProxy } from 'unpdf';

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

// Page classifier trained in ml/ (MobileNetV3-small fine-tuned on DocLayNet + synthetic pages)
// and exported by ml/export.py. Input: grayscale pages stretched to 224×320, values 0-255.
// Output: one independent probability per label (multi-label, so a page can have several).
export const PAGE_LABELS = ['table', 'figure', 'two_columns'] as const;
export type PageLabel = (typeof PAGE_LABELS)[number];

const MODEL_PATH = fileURLToPath(new URL('../models/page-classifier.onnx', import.meta.url));
const IMG_W = 224;
const IMG_H = 320;
const BATCH = 32;
const THRESHOLD = 0.5;

type Session = import('onnxruntime-node').InferenceSession;
let session: Promise<Session> | undefined;

function loadSession(): Promise<Session> {
  session ??= import('onnxruntime-node').then((ort) => ort.InferenceSession.create(MODEL_PATH));
  return session;
}

const canvasImport = () => import('@napi-rs/canvas');

// Same picture the model saw in training: MuPDF rendered the page straight to 224×320 gray.
// Here pdf.js renders at twice the width and Skia shrinks it to the same stretched size.
async function pagePixels(pdf: PDFDocumentProxy, pageNumber: number, out: Float32Array): Promise<void> {
  const { createCanvas, loadImage } = await canvasImport();
  const png = await renderPageAsImage(pdf, pageNumber, { canvasImport, width: IMG_W * 2 });
  const canvas = createCanvas(IMG_W, IMG_H);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, IMG_W, IMG_H);
  context.drawImage(await loadImage(Buffer.from(png)), 0, 0, IMG_W, IMG_H);
  const rgba = context.getImageData(0, 0, IMG_W, IMG_H).data;
  for (let i = 0; i < IMG_W * IMG_H; i++) {
    out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
}

export async function pageProbabilities(pdf: PDFDocumentProxy, pages: number[]): Promise<Map<number, number[]>> {
  const ort = await import('onnxruntime-node');
  const model = await loadSession();
  const result = new Map<number, number[]>();
  const size = IMG_W * IMG_H;
  for (let start = 0; start < pages.length; start += BATCH) {
    const batch = pages.slice(start, start + BATCH);
    const input = new Float32Array(batch.length * size);
    for (const [i, page] of batch.entries()) await pagePixels(pdf, page, input.subarray(i * size, (i + 1) * size));
    const output = await model.run({ pages: new ort.Tensor('float32', input, [batch.length, 1, IMG_H, IMG_W]) });
    const probabilities = output.probabilities.data as Float32Array;
    batch.forEach((page, i) => result.set(page, [...probabilities.subarray(i * PAGE_LABELS.length, (i + 1) * PAGE_LABELS.length)]));
  }
  return result;
}

export function labelsOf(probabilities: number[]): PageLabel[] {
  return PAGE_LABELS.filter((_, i) => probabilities[i] > THRESHOLD);
}
