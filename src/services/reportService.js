import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export const generateExcelReport = async (res, data, fileName) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sales Report');

  worksheet.columns = [
    { header: 'Order ID', key: 'orderId', width: 25 },
    { header: 'Customer', key: 'customer', width: 25 },
    { header: 'Date', key: 'date', width: 15 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Payment', key: 'payment', width: 15 },
    { header: 'Products', key: 'items', width: 40 },
    { header: 'Revenue', key: 'revenue', width: 15 },
  ];

  // Formatting header
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  data.forEach(item => {
    worksheet.addRow({
      orderId: item.orderId,
      customer: item.customer,
      date: item.date,
      status: item.status,
      payment: item.paymentMethod?.toUpperCase() || 'N/A',
      items: item.products,
      revenue: `INR ${item.revenue.toLocaleString('en-IN')}`,
    });
  });

  // Borders and Alignment
  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
      // Enable text wrap for products
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${fileName}.xlsx`);

  await workbook.xlsx.write(res);
  res.end();
};

export const generatePDFReport = (res, data, fileName, title) => {
  const doc = new PDFDocument({ margin: 30, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${fileName}.pdf`);

  doc.pipe(res);

  // Header
  doc.fontSize(20).text('ElectroHub', { align: 'center' });
  doc.fontSize(14).text(title, { align: 'center' });
  doc.moveDown();

  // Table Helper
  const tableTop = 150;
  const colWidths = [90, 80, 65, 70, 60, 110, 60];
  const tableHeaders = ['Order ID', 'Customer', 'Date', 'Status', 'Payment', 'Products', 'Revenue'];

  // Draw Headers
  let currentY = tableTop;
  doc.font('Helvetica-Bold').fontSize(8);
  let currentX = 30;
  tableHeaders.forEach((header, i) => {
    doc.text(header, currentX, currentY);
    currentX += colWidths[i];
  });

  doc.moveTo(30, currentY + 15).lineTo(565, currentY + 15).stroke();
  currentY += 25;

  // Draw Rows
  doc.font('Helvetica').fontSize(9);
  data.forEach(item => {
    if (currentY > 750) {
      doc.addPage();
      currentY = 50;
    }
    
    currentX = 30;
    doc.text(item.orderId, currentX, currentY, { width: colWidths[0] - 5 });
    currentX += colWidths[0];
    doc.text(item.customer, currentX, currentY, { width: colWidths[1] - 5 });
    currentX += colWidths[1];
    doc.text(item.date, currentX, currentY);
    currentX += colWidths[2];
    doc.text(item.status, currentX, currentY);
    currentX += colWidths[3];
    doc.text(item.paymentMethod?.toUpperCase() || 'N/A', currentX, currentY);
    currentX += colWidths[4];
    
    doc.text(item.products, currentX, currentY, { width: colWidths[5] - 5 });
    currentX += colWidths[5];

    doc.text(`INR ${item.revenue.toLocaleString('en-IN')}`, currentX, currentY, { width: colWidths[6], align: 'right' });
    
    const textHeight = Math.max(20, doc.heightOfString(item.products, { width: colWidths[5] - 5 }) + 10);
    currentY += textHeight;
  });

  doc.end();
};
