import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pages = [
    {
      title: 'Annual Report',
      body: [
        'This report describes the results of the year and the main',
        'decisions taken by the team during the last twelve months.',
        '',
        '• Revenue grew in every quarter',
        '• Costs stayed flat',
      ],
    },
    {
      title: 'Next Steps',
      body: ['We will hire two engineers and open an office in Valen-', 'cia before the end of the year.'],
    },
  ];

  pages.forEach((content, i) => {
    const page = doc.addPage([595, 842]);
    page.drawText('ACME Corp — Confidential', { x: 50, y: 810, size: 9, font });
    page.drawText(content.title, { x: 50, y: 760, size: 22, font: bold });
    let y = 720;
    for (const line of content.body) {
      if (line) page.drawText(line, { x: 50, y, size: 11, font });
      y -= line ? 15 : 30;
    }
    page.drawText(String(i + 1), { x: 290, y: 30, size: 9, font });
  });

  // A page with no text layer, like a scan.
  doc.addPage([595, 842]).drawRectangle({ x: 50, y: 50, width: 400, height: 600 });
  return doc.save();
}

export async function scannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([595, 842]).drawRectangle({ x: 50, y: 50, width: 400, height: 600 });
  return doc.save();
}

// One page per layout the classifier knows: two columns, a ruled table, a figure, plain text.
export async function layoutPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const words = 'the of model page results data method training layout document we our show using text section approach based learning network'.split(' ');
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const line = (width: number) => {
    let text = '';
    for (;;) {
      const next = `${text} ${words[Math.floor(random() * words.length)]}`.trim();
      if (font.widthOfTextAtSize(next, 9) > width) return text;
      text = next;
    }
  };
  const column = (page: ReturnType<typeof doc.addPage>, x: number, width: number, top: number, bottom: number) => {
    for (let y = top; y > bottom; y -= 11) page.drawText(line(width), { x, y, size: 9, font });
  };

  const twoColumns = doc.addPage([595, 842]);
  twoColumns.drawText('A Study of Document Layout Analysis', { x: 110, y: 790, size: 16, font: bold });
  column(twoColumns, 50, 235, 750, 60);
  column(twoColumns, 310, 235, 750, 60);

  const table = doc.addPage([595, 842]);
  column(table, 50, 495, 780, 520);
  for (let r = 0; r <= 12; r++) table.drawLine({ start: { x: 50, y: 480 - r * 20 }, end: { x: 545, y: 480 - r * 20 }, thickness: 0.6 });
  for (let c = 0; c <= 5; c++) table.drawLine({ start: { x: 50 + c * 99, y: 480 }, end: { x: 50 + c * 99, y: 240 }, thickness: 0.6 });
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 5; c++) table.drawText(String(1000 + r * 7 + c * 13), { x: 60 + c * 99, y: 466 - r * 20, size: 9, font });
  }

  const figure = doc.addPage([595, 842]);
  column(figure, 50, 495, 780, 560);
  for (let i = 0; i < 40; i++) {
    const color = rgb(((i * 37) % 100) / 100, ((i * 53) % 100) / 100, ((i * 71) % 100) / 100);
    figure.drawRectangle({ x: 80 + (i % 8) * 55, y: 200 + Math.floor(i / 8) * 65, width: 55, height: 65, color });
  }

  column(doc.addPage([595, 842]), 50, 495, 780, 60);
  return doc.save();
}

// samplePdf's first page as an image-only page, like a scan.
export async function scannedTextPdf(): Promise<Uint8Array> {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
  const pdf = await getDocumentProxy(await samplePdf());
  const png = await renderPageAsImage(pdf, 1, { canvasImport: () => import('@napi-rs/canvas'), scale: 200 / 72 });
  await pdf.loadingTask.destroy();
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(new Uint8Array(png));
  doc.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  return doc.save();
}
