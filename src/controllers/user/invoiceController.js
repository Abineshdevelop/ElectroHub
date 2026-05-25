import Order from "../../model/orderModel.js";
import PDFDocument from "pdfkit";

function fmt(n, INR = "Rs.") {
  return `${INR} ${Number(n || 0).toLocaleString("en-IN")}`;
}

function summaryRow(doc, y, label, value, opts = {}) {
  const fontSize = opts.large ? 12 : 9;
  doc
    .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(fontSize)
    .fillColor(opts.color || "#444444");
  doc.text(label, 340, y, { width: 125, align: "right" });
  doc.text(value, 470, y, { width: 75, align: "right" });
  return y + (opts.large ? 24 : 18);
}

function getItemStatus(item, orderStatus) {
  return item.status && item.status !== "pending" ? item.status : orderStatus;
}

function getItemInvoiceNumber(order, item) {
  const itemIndex = order.items.findIndex(
    (orderItem) => orderItem._id.toString() === item._id.toString(),
  );
  const productNo = String(itemIndex + 1).padStart(2, "0");
  return `INV-${new Date().getFullYear()}-${order.orderId}-P${productNo}`;
}

async function ensureOrderInvoice(order) {
  if (order.invoiceNumber) return;

  const count = await Order.countDocuments({
    invoiceNumber: { $ne: null },
  });

  order.invoiceNumber = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`;
  order.invoiceDate = new Date();
  await order.save();
}

async function ensureItemInvoice(order, item) {
  if (item.invoiceNumber) return;

  item.invoiceNumber = getItemInvoiceNumber(order, item);
  item.invoiceDate = new Date();
  await order.save();
}

function renderInvoicePdf({ res, order, invoiceItems, invoiceNumber, invoiceDateValue, singleProduct }) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const INR = "Rs.";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=invoice-${invoiceNumber}.pdf`,
  );
  doc.pipe(res);

  const addr = order.shippingAddress || {};
  const invoiceDate = new Date(invoiceDateValue || order.updatedAt).toLocaleDateString(
    "en-IN",
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
    },
  );
  const customerName =
    `${addr.firstName || ""} ${addr.lastName || ""}`.trim() || "Customer";

  doc
    .fontSize(24)
    .font("Helvetica-Bold")
    .fillColor("#111111")
    .text("ElectroHub", 50, 45);
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#888888")
    .text("Next-Gen Electronics", 50, 73);

  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("#111111")
    .text("INVOICE", 350, 45, { width: 195, align: "right" });
  doc.fontSize(9).font("Helvetica").fillColor("#555555");
  let headerY = 70;
  doc.text(`Invoice:  ${invoiceNumber}`, 350, headerY, {
    width: 195,
    align: "right",
  });
  headerY += doc.heightOfString(`Invoice:  ${invoiceNumber}`, { width: 195 });

  doc.text(`Date:      ${invoiceDate}`, 350, headerY, {
    width: 195,
    align: "right",
  });
  headerY += doc.heightOfString(`Date:      ${invoiceDate}`, { width: 195 });

  doc.text(`Order:    ${order.orderId}`, 350, headerY, {
    width: 195,
    align: "right",
  });

  doc
    .moveTo(50, 118)
    .lineTo(545, 118)
    .strokeColor("#cccccc")
    .lineWidth(0.5)
    .stroke();

  let y = 135;
  const leftCol = 50;
  const rightCol = 310;
  const leftW = 240;
  const rightW = 235;

  doc.fontSize(8).font("Helvetica-Bold").fillColor("#aaaaaa");
  doc.text("FROM", leftCol, y, { width: leftW });
  doc.text("BILL TO", rightCol, y, { width: rightW });
  y += 18;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111");
  doc.text("ElectroHub Electronics", leftCol, y, { width: leftW });
  doc.text(customerName, rightCol, y, { width: rightW });
  y += 20;

  const fromLines = [
    "123 Tech Avenue, Silicon Valley",
    "Coimbatore, Tamil Nadu, India - 641001",
    "support@electrohub.com",
  ].join("\n");

  const billToLines = [
    addr.addressLine,
    [addr.street, addr.state].filter(Boolean).join(", "),
    [addr.country || "India", addr.pincode ? `- ${addr.pincode}` : ""]
      .filter(Boolean)
      .join(" "),
    addr.phone ? `Phone: ${addr.phone}` : null,
    addr.email ? `Email: ${addr.email}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  doc.font("Helvetica").fontSize(9).fillColor("#555555");

  const fromStartY = y;
  doc.text(fromLines, leftCol, y, { width: leftW, lineGap: 4 });
  const fromEndY =
    fromStartY + doc.heightOfString(fromLines, { width: leftW, lineGap: 4 });

  doc.text(billToLines, rightCol, fromStartY, { width: rightW, lineGap: 4 });
  const billToEndY =
    fromStartY +
    doc.heightOfString(billToLines, { width: rightW, lineGap: 4 });

  y = Math.max(fromEndY, billToEndY) + 23;

  doc.rect(50, y, 495, 22).fill("#f5f5f5");

  y += 6;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
  doc.text("#", 55, y, { width: 20 });
  doc.text("PRODUCT", 80, y, { width: 190 });
  doc.text("QTY", 275, y, { width: 40, align: "center" });
  doc.text("UNIT PRICE", 320, y, { width: 75, align: "right" });
  doc.text("DISCOUNT", 400, y, { width: 65, align: "right" });
  doc.text("AMOUNT", 470, y, { width: 75, align: "right" });

  y += 22;

  let itemSubtotal = 0;
  let totalOfferDiscount = 0;
  let totalCouponDiscount = 0;
  let itemTotalPaid = 0;

  invoiceItems.forEach((item, idx) => {
    const lineTotal = Number(item.lineTotal || item.unitPrice * item.quantity || 0);
    const couponDisc = Number(item.couponDiscount || 0);
    const finalAmt = Number(item.finalAmount ?? lineTotal);
    const offerDisc = lineTotal - finalAmt - couponDisc;

    itemSubtotal += lineTotal;
    totalOfferDiscount += Math.max(0, offerDisc);
    totalCouponDiscount += couponDisc;
    itemTotalPaid += finalAmt;

    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    if (idx % 2 === 1) {
      doc.rect(50, y - 4, 495, 24).fill("#fafafa");
    }

    doc.font("Helvetica").fontSize(9).fillColor("#333333");
    doc.text(String(idx + 1), 55, y, { width: 20 });
    doc.text(item.productName || "Product", 80, y, { width: 190 });
    doc.text(String(item.quantity), 275, y, { width: 40, align: "center" });
    doc.text(fmt(item.unitPrice, INR), 320, y, {
      width: 75,
      align: "right",
    });

    const totalDisc = Math.max(0, offerDisc) + couponDisc;
    if (totalDisc > 0) {
      doc.fillColor("#16a34a").text(`-${fmt(totalDisc, INR)}`, 400, y, {
        width: 65,
        align: "right",
      });
    } else {
      doc.fillColor("#aaaaaa").text("--", 400, y, {
        width: 65,
        align: "right",
      });
    }

    doc
      .fillColor("#111111")
      .font("Helvetica-Bold")
      .text(fmt(finalAmt, INR), 470, y, { width: 75, align: "right" });

    y += 24;
  });

  doc
    .moveTo(50, y)
    .lineTo(545, y)
    .strokeColor("#cccccc")
    .lineWidth(0.5)
    .stroke();

  y += 20;

  const subtotal = singleProduct ? itemSubtotal : Number(order.subtotal || itemSubtotal);
  const couponDiscount = singleProduct
    ? totalCouponDiscount
    : Number(order.discount || 0);
  const shipping = singleProduct ? 0 : Number(order.shipping || 0);
  const totalAmount = singleProduct ? itemTotalPaid : Number(order.totalAmount || 0);

  y = summaryRow(doc, y, "Subtotal:", fmt(subtotal, INR));
  if (totalOfferDiscount > 0) {
    y = summaryRow(doc, y, "Offer Discount:", `-${fmt(totalOfferDiscount, INR)}`, {
      color: "#16a34a",
    });
  }
  if (couponDiscount > 0) {
    y = summaryRow(
      doc,
      y,
      `Coupon${order.couponCode ? ` (${order.couponCode})` : ""}:`,
      `-${fmt(couponDiscount, INR)}`,
      { color: "#2563eb" },
    );
  }
  y = summaryRow(doc, y, "Shipping:", shipping === 0 ? "FREE" : fmt(shipping, INR), {
    color: shipping === 0 ? "#16a34a" : "#444444",
  });

  doc
    .moveTo(340, y)
    .lineTo(545, y)
    .strokeColor("#333333")
    .lineWidth(1)
    .stroke();
  y += 10;
  y = summaryRow(doc, y, "Total Paid:", fmt(totalAmount, INR), {
    bold: true,
    large: true,
    color: "#111111",
  });

  const getPaymentMethodLabel = (pm) => {
    if (!pm) return "N/A";
    const lower = pm.toLowerCase();
    if (lower === "cod") return "Cash on Delivery (COD)";
    if (lower === "wallet") return "Wallet";
    if (lower === "razorpay") return "Online (Razorpay)";
    return pm.toUpperCase();
  };

  y += 5;
  doc.font("Helvetica").fontSize(8).fillColor("#888888");
  doc.text(
    `Payment Method: ${getPaymentMethodLabel(order.paymentMethod)}`,
    340,
    y,
    { width: 205, align: "right" },
  );

  const footerY = 755;
  doc
    .moveTo(50, footerY)
    .lineTo(545, footerY)
    .strokeColor("#dddddd")
    .lineWidth(0.5)
    .stroke();

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#666666")
    .text("Thank you for shopping with ElectroHub!", 50, footerY + 12, {
      align: "center",
      width: 495,
    });
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#aaaaaa")
    .text(
      "This is a computer-generated invoice and does not require a signature.",
      50,
      footerY + 28,
      { align: "center", width: 495 },
    );

  doc.end();
}

export const downloadInvoice = async (req, res) => {
  try {
    const { orderId, itemId } = req.params;
    const userId = req.session.user._id;

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return res.status(404).send("Order not found");

    if (itemId) {
      const item = order.items.id(itemId);
      if (!item) return res.status(404).send("Order item not found");

      if (getItemStatus(item, order.orderStatus) !== "delivered") {
        return res
          .status(400)
          .send("Invoice is only available for delivered products");
      }

      await ensureItemInvoice(order, item);

      return renderInvoicePdf({
        res,
        order,
        invoiceItems: [item],
        invoiceNumber: item.invoiceNumber,
        invoiceDateValue: item.invoiceDate,
        singleProduct: true,
      });
    }

    if (order.orderStatus !== "delivered") {
      return res
        .status(400)
        .send("Invoice is only available for delivered orders");
    }

    await ensureOrderInvoice(order);

    return renderInvoicePdf({
      res,
      order,
      invoiceItems: order.items,
      invoiceNumber: order.invoiceNumber,
      invoiceDateValue: order.invoiceDate,
      singleProduct: false,
    });
  } catch (error) {
    console.error("downloadInvoice error:", error);
    if (!res.headersSent) {
      res.status(500).send("Could not generate invoice");
    }
  }
};
