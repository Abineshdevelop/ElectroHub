import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { money } from "./salesRevenueService.js";

const INR = (n) => `₹${money(n).toLocaleString("en-IN")}`;

/** Light background + dark text for readable Excel status cells */
const STATUS_EXCEL_STYLES = {
  delivered: { bg: "FFD1FAE5", fg: "FF065F46" },
  cancelled: { bg: "FFFEE2E2", fg: "FF991B1B" },
  returned: { bg: "FFFFEDD5", fg: "FF9A3412" },
  return_requested: { bg: "FFFFEDD5", fg: "FF9A3412" },
  partially_cancelled: { bg: "FFFFEDD5", fg: "FF9A3412" },
  pending: { bg: "FFF3F4F6", fg: "FF374151" },
  confirmed: { bg: "FFEFF6FF", fg: "FF1D4ED8" },
  shipped: { bg: "FFDBEAFE", fg: "FF1E40AF" },
  out_for_delivery: { bg: "FFDBEAFE", fg: "FF1E40AF" },
};

const STATUS_PDF_COLORS = {
  delivered: "#065f46",
  cancelled: "#991b1b",
  returned: "#9a3412",
  return_requested: "#9a3412",
  partially_cancelled: "#9a3412",
  pending: "#374151",
  confirmed: "#1d4ed8",
  shipped: "#1e40af",
  out_for_delivery: "#1e40af",
};

function statusExcelStyle(status) {
  return STATUS_EXCEL_STYLES[status] || { bg: "FFF3F4F6", fg: "FF374151" };
}

function statusPdfColor(status) {
  return STATUS_PDF_COLORS[status] || "#374151";
}

function formatStatusLabel(status) {
  return String(status || "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** PDF-safe currency (Helvetica lacks reliable ₹ glyph) */
const INR_PDF = (n) => `Rs. ${money(n).toLocaleString("en-IN")}`;

/** Compact date for PDF cells (avoids slash wrap in narrow columns) */
function formatPdfDate(value) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function truncatePdfText(text, maxLen) {
  const s = String(text ?? "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

function shortenOrderId(orderId) {
  const id = String(orderId ?? "");
  if (id.length <= 20) return id;
  const parts = id.split("-");
  if (parts.length >= 2) return `${parts[0]}-${parts[parts.length - 1]}`;
  return truncatePdfText(id, 20);
}

/** A4 (points) — same dimensions as invoice PDFs */
const A4_PAGE = [595.28, 841.89];
const PDF_MARGIN = 36;

const PDF_THEME = {
  ink: "#111827",
  muted: "#6b7280",
  border: "#e5e7eb",
  headerBg: "#1f2937",
  headerFg: "#ffffff",
  stripe: "#f9fafb",
  white: "#ffffff",
};

const MONEY_COL_KEYS = new Set([
  "originalAmount",
  "discount",
  "refund",
  "finalRevenue",
]);

function pdfPageOptions(orientation = "portrait") {
  return { size: A4_PAGE, margin: PDF_MARGIN, layout: orientation };
}

/** Fit columns to printable width; flex columns absorb leftover space */
function fitColumnsToWidth(cols, availableWidth) {
  const result = cols.map((c) => ({ ...c, w: c.w }));
  const sum = () => result.reduce((s, c) => s + c.w, 0);

  let total = sum();
  if (total > availableWidth) {
    for (let pass = 0; pass < 24 && total > availableWidth; pass += 1) {
      const ratio = availableWidth / total;
      for (const col of result) {
        col.w = Math.max(col.minW || 24, Math.floor(col.w * ratio));
      }
      total = sum();
      if (total > availableWidth) {
        const shrinkable = result
          .filter((c) => c.w > (c.minW || 24))
          .sort((a, b) => b.w - a.w);
        for (const col of shrinkable) {
          if (total <= availableWidth) break;
          col.w -= 1;
          total -= 1;
        }
      }
    }
  }

  const spare = availableWidth - sum();
  if (spare > 0) {
    const flexCols = result.filter((c) => c.flex);
    if (flexCols.length) {
      let remaining = spare;
      flexCols.forEach((col, idx) => {
        const add = idx === flexCols.length - 1 ? remaining : Math.floor(spare / flexCols.length);
        col.w += add;
        remaining -= add;
      });
    }
  }

  return result;
}

function formatPdfPayment(row) {
  const method = truncatePdfText((row.paymentMethod || "—").toUpperCase(), 14);
  const status = truncatePdfText(row.paymentStatus || "—", 14);
  return `${method} / ${status}`;
}

function formatPdfProducts(text, maxLen = 72) {
  const raw = String(text ?? "—").trim();
  if (!raw || raw === "—") return "—";
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => truncatePdfText(part, maxLen))
    .join("\n");
}

function styleHeaderRow(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  row.height = 22;
}

function applyCurrencyCols(sheet, cols) {
  cols.forEach((col) => {
    sheet.getColumn(col).numFmt = '"₹"#,##0';
    sheet.getColumn(col).alignment = { horizontal: "right" };
  });
}

function autoWidth(sheet, min = 10, max = 48) {
  sheet.columns.forEach((col) => {
    let w = min;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? "").length;
      if (len + 2 > w) w = Math.min(max, len + 2);
    });
    col.width = w;
  });
}

export async function generateSalesExcelReport(res, payload, fileName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = payload.meta.companyName;
  wb.created = new Date();

  const { summary, orderRows, topProducts, topCategories, revenueTrend, paymentAnalytics, meta } = payload;

  // ── Sheet 1: Summary ──
  const summarySheet = wb.addWorksheet("Summary", { views: [{ showGridLines: false }] });
  summarySheet.mergeCells("A1:D1");
  summarySheet.getCell("A1").value = meta.companyName;
  summarySheet.getCell("A1").font = { size: 18, bold: true };
  summarySheet.getCell("A2").value = meta.title;
  summarySheet.getCell("A2").font = { size: 14, bold: true };
  summarySheet.getCell("A4").value = `From: ${meta.from}`;
  summarySheet.getCell("A5").value = `To: ${meta.to}`;
  summarySheet.getCell("A6").value = `Generated At: ${meta.generatedAt}`;
  summarySheet.getCell("A7").value = `Generated By: ${meta.generatedBy}`;
  summarySheet.getCell("A8").value = `Period: ${meta.periodLabel}`;

  const kpiRows = [
    ["Metric", "Value"],
    ["Total Orders", summary.totalOrders],
    ["Delivered Orders", summary.deliveredOrders],
    ["Cancelled Orders", summary.cancelledOrders],
    ["Returned Orders", summary.returnedOrders],
    ["Pending / In Progress", summary.pendingOrders],
    ["Gross Revenue (Delivered Items)", summary.grossRevenue],
    ["Total Discounts", summary.totalDiscounts],
    ["Refund Amount", summary.refundAmount],
    ["Net Revenue", summary.netRevenue],
  ];
  let r = 10;
  kpiRows.forEach((row, idx) => {
    summarySheet.getRow(r).values = row;
    if (idx === 0) styleHeaderRow(summarySheet.getRow(r));
    r += 1;
  });
  applyCurrencyCols(summarySheet, [2]);
  summarySheet.getColumn(1).width = 32;
  summarySheet.getColumn(2).width = 22;

  r += 2;
  summarySheet.getCell(`A${r}`).value = "Revenue Trend (Daily Net Revenue)";
  summarySheet.getCell(`A${r}`).font = { bold: true };
  r += 1;
  const trendHeader = summarySheet.getRow(r);
  trendHeader.values = ["Date", "Net Revenue"];
  styleHeaderRow(trendHeader);
  r += 1;
  revenueTrend.forEach((t) => {
    summarySheet.getRow(r).values = [t.date, t.revenue];
    r += 1;
  });
  applyCurrencyCols(summarySheet, [2]);

  r += 2;
  summarySheet.getCell(`A${r}`).value = "Best Selling Products (Top 10)";
  summarySheet.getCell(`A${r}`).font = { bold: true };
  r += 1;
  const prodH = summarySheet.getRow(r);
  prodH.values = ["Product", "Units Sold", "Revenue"];
  styleHeaderRow(prodH);
  r += 1;
  topProducts.slice(0, 10).forEach((p) => {
    summarySheet.getRow(r).values = [p.name, p.units, p.revenue];
    r += 1;
  });

  // ── Sheet 2: Orders ──
  const ordersSheet = wb.addWorksheet("Orders", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ordersSheet.columns = [
    { header: "Order ID", key: "orderId", width: 22 },
    { header: "Customer", key: "customer", width: 22 },
    { header: "Order Date", key: "date", width: 14 },
    { header: "Order Status", key: "status", width: 20 },
    { header: "Payment Method", key: "paymentMethod", width: 14 },
    { header: "Payment Status", key: "paymentStatus", width: 16 },
    { header: "Products", key: "products", width: 36 },
    { header: "Qty", key: "quantity", width: 12 },
    { header: "Original Amount", key: "originalAmount", width: 14 },
    { header: "Discount", key: "discount", width: 12 },
    { header: "Refund", key: "refund", width: 12 },
    { header: "Final Revenue", key: "finalRevenue", width: 14 },
  ];
  styleHeaderRow(ordersSheet.getRow(1));
  orderRows.forEach((row) => {
    const added = ordersSheet.addRow({
      orderId: row.orderId,
      customer: row.customer,
      date: row.date,
      status: formatStatusLabel(row.status),
      paymentMethod: row.paymentMethod,
      paymentStatus: row.paymentStatus,
      products: row.products,
      quantity: row.quantity,
      originalAmount: row.originalAmount,
      discount: row.discount,
      refund: row.refund,
      finalRevenue: row.finalRevenue,
    });
    const statusCell = added.getCell(4);
    const { bg, fg } = statusExcelStyle(row.status);
    statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
    statusCell.font = { color: { argb: fg }, bold: true, size: 11 };
    statusCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    added.eachCell((cell, colNumber) => {
      if (colNumber !== 4) cell.font = { size: 11 };
    });
  });
  applyCurrencyCols(ordersSheet, [9, 10, 11, 12]);
  ordersSheet.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  };
  ordersSheet.autoFilter = { from: "A1", to: "L1" };
  autoWidth(ordersSheet);

  // ── Sheet 3: Product Analytics ──
  const prodSheet = wb.addWorksheet("Product Analytics", { views: [{ state: "frozen", ySplit: 1 }] });
  prodSheet.columns = [
    { header: "Product", key: "name", width: 32 },
    { header: "Units Sold", key: "units", width: 14 },
    { header: "Revenue", key: "revenue", width: 16 },
  ];
  styleHeaderRow(prodSheet.getRow(1));
  topProducts.forEach((p) => prodSheet.addRow(p));
  applyCurrencyCols(prodSheet, [3]);
  prodSheet.autoFilter = { from: "A1", to: "C1" };

  const catStart = topProducts.length + 4;
  prodSheet.getCell(`A${catStart}`).value = "Top Categories";
  prodSheet.getCell(`A${catStart}`).font = { bold: true, size: 12 };
  const catH = prodSheet.getRow(catStart + 1);
  catH.values = ["Category", "Units Sold", "Revenue"];
  styleHeaderRow(catH);
  let cr = catStart + 2;
  topCategories.forEach((c) => {
    prodSheet.getRow(cr).values = [c.name, c.units, c.revenue];
    cr += 1;
  });
  applyCurrencyCols(prodSheet, [3]);

  // ── Sheet 4: Payment Analytics ──
  const paySheet = wb.addWorksheet("Payment Analytics");
  paySheet.columns = [
    { header: "Payment Type", key: "type", width: 24 },
    { header: "Orders", key: "orders", width: 12 },
    { header: "Net Revenue", key: "revenue", width: 16 },
  ];
  styleHeaderRow(paySheet.getRow(1));
  const payRows = [
    { type: "COD Orders", orders: paymentAnalytics.cod.orders, revenue: paymentAnalytics.cod.revenue },
    { type: "Razorpay Orders", orders: paymentAnalytics.razorpay.orders, revenue: paymentAnalytics.razorpay.revenue },
    { type: "Wallet Orders", orders: paymentAnalytics.wallet.orders, revenue: paymentAnalytics.wallet.revenue },
    { type: "Other Payment Methods", orders: paymentAnalytics.other.orders, revenue: paymentAnalytics.other.revenue },
    { type: "Failed Payments", orders: paymentAnalytics.failed.orders, revenue: 0 },
    { type: "Refunded Payments", orders: paymentAnalytics.refunded.orders, revenue: paymentAnalytics.refunded.amount },
  ];
  payRows.forEach((p) => paySheet.addRow(p));
  applyCurrencyCols(paySheet, [3]);
  autoWidth(paySheet);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

/** ── PDF report builder (portrait summary + landscape order table) ── */

const ORDER_TABLE_COLS = [
  { key: "orderId", label: "Order ID", w: 68, minW: 58 },
  { key: "customer", label: "Customer", w: 62, minW: 50 },
  { key: "date", label: "Date", w: 54, minW: 50 },
  { key: "status", label: "Status", w: 68, minW: 58 },
  { key: "payment", label: "Payment", w: 62, minW: 54 },
  { key: "products", label: "Products", w: 180, minW: 120, flex: true },
  { key: "quantity", label: "Qty", w: 28, minW: 24 },
  { key: "originalAmount", label: "Original", w: 54, minW: 48 },
  { key: "discount", label: "Discount", w: 52, minW: 46 },
  { key: "refund", label: "Refund", w: 52, minW: 46 },
  { key: "finalRevenue", label: "Net Rev.", w: 54, minW: 48 },
];

function createPdfWriter(doc, margin) {
  const contentWidth = (page) => page.width - margin * 2;

  const addPage = (orientation = "portrait") => {
    doc.addPage(pdfPageOptions(orientation));
    return doc.page;
  };

  const sectionTitle = (text, y = margin) => {
    doc.font("Helvetica-Bold").fontSize(13).fillColor(PDF_THEME.ink).text(text, margin, y);
    return y + 20;
  };

  const drawRule = (y) => {
    doc
      .moveTo(margin, y)
      .lineTo(doc.page.width - margin, y)
      .strokeColor(PDF_THEME.border)
      .lineWidth(1)
      .stroke();
    return y + 12;
  };

  return { contentWidth, addPage, sectionTitle, drawRule };
}

function drawPdfCover(doc, writer, meta, summary) {
  const margin = PDF_MARGIN;
  const w = writer.contentWidth(doc.page);
  let y = margin;

  doc.font("Helvetica-Bold").fontSize(22).fillColor(PDF_THEME.ink);
  doc.text(meta.companyName, margin, y, { width: w, align: "center" });
  y = doc.y + 4;

  doc.fontSize(15).fillColor("#374151").text(meta.title, margin, y, { width: w, align: "center" });
  y = doc.y + 10;

  doc.font("Helvetica").fontSize(10).fillColor(PDF_THEME.muted);
  const metaLines = [
    `Period: ${meta.periodLabel}`,
    `Date range: ${meta.from} to ${meta.to}`,
    `Generated on ${meta.generatedAt}`,
  ];
  metaLines.forEach((line) => {
    doc.text(line, margin, y, { width: w, align: "center" });
    y = doc.y + 2;
  });

  y = writer.drawRule(y + 6);
  y = writer.sectionTitle("Executive Summary", y);

  const kpis = [
    ["Total Orders", summary.totalOrders],
    ["Delivered", summary.deliveredOrders],
    ["Cancelled", summary.cancelledOrders],
    ["Returned", summary.returnedOrders],
    ["Pending / In Progress", summary.pendingOrders],
    ["Gross Revenue", INR_PDF(summary.grossRevenue)],
    ["Total Discounts", INR_PDF(summary.totalDiscounts)],
    ["Refund Amount", INR_PDF(summary.refundAmount)],
    ["Net Revenue", INR_PDF(summary.netRevenue)],
  ];

  const colW = (w - 16) / 2;
  const boxH = 34;
  const startX = margin;
  let rowY = y;

  kpis.forEach(([label, value], idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = startX + col * (colW + 16);
    const boxY = rowY + row * (boxH + 8);

    doc.roundedRect(x, boxY, colW, boxH, 4).fillAndStroke(idx % 4 < 2 ? PDF_THEME.stripe : PDF_THEME.white, PDF_THEME.border);
    doc.font("Helvetica").fontSize(8.5).fillColor(PDF_THEME.muted).text(label, x + 8, boxY + 7, { width: colW - 16 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_THEME.ink).text(String(value), x + 8, boxY + 18, {
      width: colW - 16,
    });
  });

  doc.y = rowY + Math.ceil(kpis.length / 2) * (boxH + 8) + 12;
}

function drawPdfRankedList(doc, writer, title, rows, formatRow) {
  const margin = PDF_MARGIN;
  const w = writer.contentWidth(doc.page);
  if (doc.y > doc.page.height - 100) writer.addPage("portrait");

  let y = writer.sectionTitle(title, doc.y);
  const lineH = 16;

  rows.slice(0, 8).forEach((row, idx) => {
    if (y + lineH > doc.page.height - PDF_MARGIN - 40) {
      writer.addPage("portrait");
      y = writer.sectionTitle(`${title} (cont.)`, PDF_MARGIN);
    }
    doc.font("Helvetica").fontSize(9.5).fillColor(PDF_THEME.ink);
    doc.text(`${idx + 1}. ${formatRow(row)}`, margin, y, { width: w, lineBreak: false });
    y += lineH;
  });

  doc.y = y + 8;
}

function buildOrderTableCells(row) {
  return {
    orderId: shortenOrderId(row.orderId),
    customer: truncatePdfText(row.customer, 18),
    date: formatPdfDate(row.orderDate || row.date),
    status: formatStatusLabel(row.status),
    payment: formatPdfPayment(row),
    products: formatPdfProducts(row.products),
    quantity: String(row.quantity ?? 0),
    originalAmount: INR_PDF(row.originalAmount),
    discount: INR_PDF(row.discount),
    refund: row.refund > 0 ? INR_PDF(row.refund) : "—",
    finalRevenue: INR_PDF(row.finalRevenue),
  };
}

function drawPdfOrderTable(doc, writer, orderRows) {
  const margin = PDF_MARGIN;
  const TABLE = {
    headerH: 24,
    fontSize: 8.5,
    headerFont: 9,
    pad: 5,
    minRowH: 22,
    maxRowH: 44,
  };

  writer.addPage("landscape");

  const left = margin;
  const tableW = writer.contentWidth(doc.page);
  const cols = fitColumnsToWidth(ORDER_TABLE_COLS, tableW);
  const productsCol = cols.find((c) => c.key === "products");
  const pageBottom = () => doc.page.height - margin - 32;

  const drawTableHeader = (startY) => {
    let x = left;
    doc.font("Helvetica-Bold").fontSize(TABLE.headerFont);
    cols.forEach((col) => {
      doc.rect(x, startY, col.w, TABLE.headerH).fill(PDF_THEME.headerBg);
      const align = MONEY_COL_KEYS.has(col.key) ? "right" : "left";
      doc.fillColor(PDF_THEME.headerFg).text(col.label, x + TABLE.pad, startY + 7, {
        width: col.w - TABLE.pad * 2,
        align,
        lineBreak: false,
      });
      x += col.w;
    });
    return startY + TABLE.headerH + 2;
  };

  const measureRowHeight = (cells) => {
    const innerW = productsCol.w - TABLE.pad * 2;
    const textH = doc.heightOfString(cells.products, {
      width: innerW,
      lineBreak: true,
    });
    return Math.max(TABLE.minRowH, Math.min(TABLE.maxRowH, textH + 14));
  };

  const drawCell = (text, x, y, col, rowH, options = {}) => {
    const { bold = false, color = PDF_THEME.ink, align = "left", multiline = false } = options;
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(TABLE.fontSize)
      .fillColor(color)
      .text(String(text ?? ""), x + TABLE.pad, y + 7, {
        width: col.w - TABLE.pad * 2,
        height: rowH - 10,
        align,
        lineBreak: multiline,
      });
  };

  let y = writer.sectionTitle("Detailed Orders", margin);
  y = drawTableHeader(y);

  for (let i = 0; i < orderRows.length; i += 1) {
    const row = orderRows[i];
    const cells = buildOrderTableCells(row);
    const rowH = measureRowHeight(cells);

    if (y + rowH > pageBottom()) {
      writer.addPage("landscape");
      y = writer.sectionTitle("Detailed Orders (continued)", margin);
      y = drawTableHeader(y);
    }

    const stripe = i % 2 === 0 ? PDF_THEME.stripe : PDF_THEME.white;
    let x = left;

    cols.forEach((col) => {
      doc.rect(x, y, col.w, rowH).fillAndStroke(stripe, PDF_THEME.border);

      if (col.key === "status") {
        drawCell(cells.status, x, y, col, rowH, {
          bold: true,
          color: statusPdfColor(row.status),
        });
      } else if (MONEY_COL_KEYS.has(col.key)) {
        drawCell(cells[col.key], x, y, col, rowH, { align: "right" });
      } else if (col.key === "products") {
        drawCell(cells.products, x, y, col, rowH, { multiline: true });
      } else if (col.key === "quantity") {
        drawCell(cells.quantity, x, y, col, rowH, { align: "center" });
      } else {
        drawCell(cells[col.key], x, y, col, rowH);
      }

      x += col.w;
    });

    y += rowH;
  }

  doc.font("Helvetica").fontSize(7.5).fillColor(PDF_THEME.muted);
  doc.text(
    "Amounts in INR (Rs.) · Dates DD-MM-YYYY · Qty = total units ordered · Net revenue from delivered items",
    left,
    doc.page.height - margin - 14,
    { width: tableW },
  );
}

function drawPdfTotalsPage(doc, writer, meta, summary) {
  writer.addPage("portrait");
  const w = writer.contentWidth(doc.page);
  let y = writer.sectionTitle("Report Totals", PDF_MARGIN + 4);

  const cards = [
    ["Net Revenue", INR_PDF(summary.netRevenue)],
    ["Gross Revenue", INR_PDF(summary.grossRevenue)],
    ["Refunds", INR_PDF(summary.refundAmount)],
    ["Total Orders", summary.totalOrders],
  ];

  const cardW = (w - 24) / 2;
  cards.forEach(([label, value], idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = PDF_MARGIN + col * (cardW + 24);
    const boxY = y + row * 42;
    doc.roundedRect(x, boxY, cardW, 34, 4).fillAndStroke(PDF_THEME.stripe, PDF_THEME.border);
    doc.font("Helvetica").fontSize(9).fillColor(PDF_THEME.muted).text(label, x + 10, boxY + 8);
    doc.font("Helvetica-Bold").fontSize(12).fillColor(PDF_THEME.ink).text(String(value), x + 10, boxY + 20);
  });

  y += 96;
  doc.font("Helvetica").fontSize(10).fillColor(PDF_THEME.muted).text(
    "Revenue counts delivered line items only. Returns and refunds reduce net revenue.",
    PDF_MARGIN,
    y,
    { width: w },
  );
  doc.fontSize(8).text(`${meta.companyName} — Confidential`, PDF_MARGIN, y + 28, { width: w });
}

function drawPdfFooters(document, writer, meta) {
  const margin = PDF_MARGIN;
  const range = document.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    document.switchToPage(i);
    const w = writer.contentWidth(document.page);
    const bottom = document.page.height - 24;
    const orient = document.page.width > document.page.height ? "Landscape" : "Portrait";

    document.font("Helvetica").fontSize(7.5).fillColor(PDF_THEME.muted);
    document.text(`${meta.companyName} — Sales Report (${orient})`, margin, bottom, {
      width: w * 0.6,
      lineBreak: false,
    });
    document.text(`Page ${i + 1} of ${range.count}`, margin, bottom, {
      align: "right",
      width: w,
      lineBreak: false,
    });
  }
}

export function generateSalesPDFReport(res, payload, fileName) {
  const { summary, orderRows, topProducts, topCategories, meta } = payload;
  const doc = new PDFDocument({ ...pdfPageOptions(), bufferPages: true });
  const writer = createPdfWriter(doc, PDF_MARGIN);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}.pdf"`);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  doc.pipe(res);

  drawPdfCover(doc, writer, meta, summary);

  drawPdfRankedList(
    doc,
    writer,
    "Best Selling Products",
    topProducts,
    (p) => `${truncatePdfText(p.name, 48)} — ${p.units} units — ${INR_PDF(p.revenue)}`,
  );

  if (topCategories.length) {
    drawPdfRankedList(
      doc,
      writer,
      "Top Categories",
      topCategories,
      (c) => `${truncatePdfText(c.name, 48)} — ${c.units} units — ${INR_PDF(c.revenue)}`,
    );
  }

  drawPdfOrderTable(doc, writer, orderRows);
  drawPdfTotalsPage(doc, writer, meta, summary);
  drawPdfFooters(doc, writer, meta);

  doc.end();
}
