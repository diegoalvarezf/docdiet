import { PDFDocument, StandardFonts } from 'pdf-lib';

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
