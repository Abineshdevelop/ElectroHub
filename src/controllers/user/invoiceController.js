import Order from "../../model/orderModel.js";
import PDFDocument from "pdfkit";

function formatAmount(amount, currencySymbol = "Rs.") {
  return `${currencySymbol} ${Number(amount || 0).toLocaleString("en-IN")}`;
}

function summaryRow(doc, yCoordinate, label, value, options = {}) {
  const fontSize = options.large ? 12 : 9;
  doc
    .font(options.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(fontSize)
    .fillColor(options.color || "#444444");
  doc.text(label, 340, yCoordinate, { width: 125, align: "right" });
  doc.text(value, 470, yCoordinate, { width: 75, align: "right" });
  return yCoordinate + (options.large ? 24 : 18);
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
  const currencySymbol = "Rs.";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=invoice-${invoiceNumber}.pdf`,
  );
  doc.pipe(res);

  const address = order.shippingAddress || {};
  const invoiceDate = new Date(invoiceDateValue || order.updatedAt).toLocaleDateString(
    "en-IN",
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
    },
  );
  const customerName =
    `${address.firstName || ""} ${address.lastName || ""}`.trim() || "Customer";

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

  let yCoordinate = 135;
  const leftColumn = 50;
  const rightColumn = 310;
  const leftColumnWidth = 240;
  const rightColumnWidth = 235;

  doc.fontSize(8).font("Helvetica-Bold").fillColor("#aaaaaa");
  doc.text("FROM", leftColumn, yCoordinate, { width: leftColumnWidth });
  doc.text("BILL TO", rightColumn, yCoordinate, { width: rightColumnWidth });
  yCoordinate += 18;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111");
  doc.text("ElectroHub Electronics", leftColumn, yCoordinate, { width: leftColumnWidth });
  doc.text(customerName, rightColumn, yCoordinate, { width: rightColumnWidth });
  yCoordinate += 20;

  const fromLines = [
    "123 Tech Avenue, Silicon Valley",
    "Coimbatore, Tamil Nadu, India - 641001",
    "support@electrohub.com",
  ].join("\n");

  const billToLines = [
    address.addressLine,
    [address.street, address.state].filter(Boolean).join(", "),
    [address.country || "India", address.pincode ? `- ${address.pincode}` : ""]
      .filter(Boolean)
      .join(" "),
    address.phone ? `Phone: ${address.phone}` : null,
    address.email ? `Email: ${address.email}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  doc.font("Helvetica").fontSize(9).fillColor("#555555");

  const fromStartY = yCoordinate;
  doc.text(fromLines, leftColumn, yCoordinate, { width: leftColumnWidth, lineGap: 4 });
  const fromEndY =
    fromStartY + doc.heightOfString(fromLines, { width: leftColumnWidth, lineGap: 4 });

  doc.text(billToLines, rightColumn, fromStartY, { width: rightColumnWidth, lineGap: 4 });
  const billToEndY =
    fromStartY +
    doc.heightOfString(billToLines, { width: rightColumnWidth, lineGap: 4 });

  yCoordinate = Math.max(fromEndY, billToEndY) + 23;

  doc.rect(50, yCoordinate, 495, 22).fill("#f5f5f5");

  yCoordinate += 6;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
  doc.text("#", 55, yCoordinate, { width: 20 });
  doc.text("PRODUCT", 80, yCoordinate, { width: 190 });
  doc.text("QTY", 275, yCoordinate, { width: 40, align: "center" });
  doc.text("UNIT PRICE", 320, yCoordinate, { width: 75, align: "right" });
  doc.text("DISCOUNT", 400, yCoordinate, { width: 65, align: "right" });
  doc.text("AMOUNT", 470, yCoordinate, { width: 75, align: "right" });

  yCoordinate += 22;

  let itemSubtotal = 0;
  let totalOfferDiscount = 0;
  let totalCouponDiscount = 0;
  let itemTotalPaid = 0;

  invoiceItems.forEach((item, index) => {
    const lineTotal = Number(item.lineTotal || item.unitPrice * item.quantity || 0);
    const couponDiscount = Number(item.couponDiscount || 0);
    const finalAmount = Number(item.finalAmount ?? lineTotal);
    const offerDiscount = lineTotal - finalAmount - couponDiscount;

    itemSubtotal += lineTotal;
    totalOfferDiscount += Math.max(0, offerDiscount);
    totalCouponDiscount += couponDiscount;
    itemTotalPaid += finalAmount;

    if (yCoordinate > 700) {
      doc.addPage();
      yCoordinate = 50;
    }

    if (index % 2 === 1) {
      doc.rect(50, yCoordinate - 4, 495, 24).fill("#fafafa");
    }

    doc.font("Helvetica").fontSize(9).fillColor("#333333");
    doc.text(String(index + 1), 55, yCoordinate, { width: 20 });
    doc.text(item.productName || "Product", 80, yCoordinate, { width: 190 });
    doc.text(String(item.quantity), 275, yCoordinate, { width: 40, align: "center" });
    doc.text(formatAmount(item.unitPrice, currencySymbol), 320, yCoordinate, {
      width: 75,
      align: "right",
    });

    const totalDiscountAmount = Math.max(0, offerDiscount) + couponDiscount;
    if (totalDiscountAmount > 0) {
      doc.fillColor("#16a34a").text(`-${formatAmount(totalDiscountAmount, currencySymbol)}`, 400, yCoordinate, {
        width: 65,
        align: "right",
      });
    } else {
      doc.fillColor("#aaaaaa").text("--", 400, yCoordinate, {
        width: 65,
        align: "right",
      });
    }

    doc
      .fillColor("#111111")
      .font("Helvetica-Bold")
      .text(formatAmount(finalAmount, currencySymbol), 470, yCoordinate, { width: 75, align: "right" });

    yCoordinate += 24;
  });

  doc
    .moveTo(50, yCoordinate)
    .lineTo(545, yCoordinate)
    .strokeColor("#cccccc")
    .lineWidth(0.5)
    .stroke();

  yCoordinate += 20;

  const subtotal = singleProduct ? itemSubtotal : Number(order.subtotal || itemSubtotal);
  const couponDiscount = singleProduct
    ? totalCouponDiscount
    : Number(order.discount || 0);
  const shipping = singleProduct ? 0 : Number(order.shipping || 0);
  const totalAmount = singleProduct ? itemTotalPaid : Number(order.totalAmount || 0);

  yCoordinate = summaryRow(doc, yCoordinate, "Subtotal:", formatAmount(subtotal, currencySymbol));
  if (totalOfferDiscount > 0) {
    yCoordinate = summaryRow(doc, yCoordinate, "Offer Discount:", `-${formatAmount(totalOfferDiscount, currencySymbol)}`, {
      color: "#16a34a",
    });
  }
  if (couponDiscount > 0) {
    yCoordinate = summaryRow(
      doc,
      yCoordinate,
      `Coupon${order.couponCode ? ` (${order.couponCode})` : ""}:`,
      `-${formatAmount(couponDiscount, currencySymbol)}`,
      { color: "#2563eb" },
    );
  }
  yCoordinate = summaryRow(doc, yCoordinate, "Shipping:", shipping === 0 ? "FREE" : formatAmount(shipping, currencySymbol), {
    color: shipping === 0 ? "#16a34a" : "#444444",
  });

  doc
    .moveTo(340, yCoordinate)
    .lineTo(545, yCoordinate)
    .strokeColor("#333333")
    .lineWidth(1)
    .stroke();
  yCoordinate += 10;
  yCoordinate = summaryRow(doc, yCoordinate, "Total Paid:", formatAmount(totalAmount, currencySymbol), {
    bold: true,
    large: true,
    color: "#111111",
  });

  const getPaymentMethodLabel = (paymentMethod) => {
    if (!paymentMethod) return "N/A";
    const lower = paymentMethod.toLowerCase();
    if (lower === "cod") return "Cash on Delivery (COD)";
    if (lower === "wallet") return "Wallet";
    if (lower === "razorpay") return "Online (Razorpay)";
    return paymentMethod.toUpperCase();
  };

  yCoordinate += 5;
  doc.font("Helvetica").fontSize(8).fillColor("#888888");
  doc.text(
    `Payment Method: ${getPaymentMethodLabel(order.paymentMethod)}`,
    340,
    yCoordinate,
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
