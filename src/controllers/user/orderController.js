import mongoose from "mongoose";
import Order   from "../../model/orderModel.js";
import Variant from "../../model/variantModel.js";
//import Coupon  from "../../model/couponModel.js";
import { creditWallet } from "./walletController.js";
import PDFDocument from "pdfkit";

function fmt(n, INR = "Rs.") {
  return `${INR} ${Number(n).toLocaleString("en-IN")}`;
}

function summaryRow(doc, y, label, value, opts = {}) {
  const fontSize = opts.large ? 12 : 9;
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(fontSize)
    .fillColor(opts.color || "#444444");
  doc.text(label, 340, y, { width: 125, align: "right" });
  doc.text(value, 470, y, { width: 75, align: "right" });
  return y + (opts.large ? 24 : 18);
}

async function restoreStock(items) {
  await Promise.all(
    items.map((item) =>
      Variant.findByIdAndUpdate(item.variantId, {
        $inc: { stock: item.quantity },
      })
    )
  );
}

//if the orders are partially cancelled other active items are keep confirmed
function getEffectiveStatus(item, orderStatus) {
  if (item.status && !["pending", "partially_cancelled"].includes(item.status)) {
    return item.status;
  }

  if (["partially_cancelled", "cancelled"].includes(orderStatus)) {
    return "confirmed";
  }
  return orderStatus;
}

export const getOrderHistory = async (req, res) => {
  try {
    const userId          = req.session.user._id;
    const { tab = "all" } = req.query;

    const filter = { userId };
    if (tab === "pending")   filter.orderStatus = { $in: ["confirmed", "processing"] };
    if (tab === "completed") filter.orderStatus = "delivered";
    if (tab === "cancelled") filter.orderStatus = { $in: ["cancelled", "partially_cancelled"] };
    if (tab === "returned")  filter.orderStatus = "returned";

    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();

    const [allCount, pendingCount, completedCount, cancelledCount, returnedCount] =
      await Promise.all([
        Order.countDocuments({ userId }),
        Order.countDocuments({ userId, orderStatus: { $in: ["confirmed", "processing"] } }),
        Order.countDocuments({ userId, orderStatus: "delivered" }),
        Order.countDocuments({ userId, orderStatus: { $in: ["cancelled", "partially_cancelled"] } }),
        Order.countDocuments({ userId, orderStatus: "returned" }),
      ]);
    
    res.render("user/orderStatus/orders", {
      user: req.session.user,
      orders,
      activeTab: tab,
      counts: { allCount, pendingCount, completedCount, cancelledCount, returnedCount },
    });
  } catch (error) {
    console.error("getOrderHistory error:", error);
    res.redirect("/user/home");
  }
};

export const getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(orderId))
      return res.redirect("/user/orders");

    const userId = req.session.user._id;
    const order  = await Order.findOne({ _id: orderId, userId }).lean();

    if (!order) return res.redirect("/user/orders");

    res.render("user/orderStatus/orderDetails", {
      user: req.session.user,
      order,
    });
  } catch (error) {
    console.error("getOrderDetails error:", error);
    res.redirect("/user/orders");
  }
};

export const cancelOrder = async (req, res) => {
  try {
    const userId             = req.session.user._id;
    const { orderId }        = req.params;
    const { reason, itemId } = req.body;

    if (!reason?.trim())
      return res.json({ success: false, message: "Please provide a cancellation reason" });

    if (!mongoose.Types.ObjectId.isValid(orderId))
      return res.json({ success: false, message: "Invalid order ID" });

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order)
      return res.json({ success: false, message: "Order not found" });

    //item cancel
    if (itemId) {
      // Block partial cancellation on coupon/offer orders
      if (order.discount > 0)
        return res.json({
          success: false,
          message: "Partial cancellation is not allowed for orders with a coupon or offer discount. Please cancel the entire order."
        });

      const item = order.items.find(i => i._id.toString() === itemId);
      if (!item)
        return res.json({ success: false, message: "Item not found in order" });

      if (item.status === "cancelled")
        return res.json({ success: false, message: "Item already cancelled" });

      const effectiveItemStatus = getEffectiveStatus(item, order.orderStatus);
      if (!["confirmed", "processing"].includes(effectiveItemStatus))
        return res.json({ success: false, message: `Item cannot be cancelled at this stage (${effectiveItemStatus})` });

      //item refund caculation
      let refundAmount = 0;

      if (order.paymentStatus === "paid" || order.paymentMethod === "wallet") {
        const cancelItemPrice = item.lineTotal || (item.unitPrice * item.quantity) || 0;
        // Cap at what's technically refundable as a safety check
        const alreadyRefunded = order.refundAmount || 0;
        const maxRefundable = Math.max(0, (order.totalAmount || 0) - alreadyRefunded);
        refundAmount = Math.max(0, Math.min(cancelItemPrice, maxRefundable));
      }

      // Mark item cancelled
      item.status       = "cancelled";
      item.cancelReason = reason.trim();
      item.cancelledAt  = new Date();

      if (refundAmount > 0) {
        order.refundAmount      = (order.refundAmount || 0) + refundAmount;
        order.refundStatus      = "processed";
        order.refundProcessedAt = new Date();

        await creditWallet(
          userId,
          refundAmount,
          `Refund for cancelled item "${item.productName}" in order #${order.orderId}`,
          "order_refund",
          order._id
        );
      }

      // Only restore stock if it was actually deducted (payment paid)
      if (order.paymentStatus === "paid" || ["card", "wallet"].includes(order.paymentMethod) && order.paymentStatus !== "pending" && order.paymentStatus !== "failed") {
        await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
      }


      // Recalculate order-level status
      const allCancelled = order.items.every(i => i.status === "cancelled");
      if (allCancelled) {
        order.orderStatus  = "cancelled";
        order.cancelReason = reason.trim();
        order.cancelledAt  = new Date();
        if (["paid", "adjusted"].includes(order.paymentStatus))
          order.paymentStatus = "refunded";
      } else {
        order.orderStatus = "partially_cancelled";
      }

      await order.save();

      let msg = "Item cancelled successfully.";
      if (refundAmount > 0) {
        msg = `Item cancelled. ₹${refundAmount.toLocaleString("en-IN")} refunded to your wallet.`;
      }

      return res.json({
        success: true,
        message: msg,
        refundAmount,
        orderStatus: order.orderStatus,
      });
    }


    //full order cancel
    if (!["confirmed", "processing", "partially_cancelled"].includes(order.orderStatus))
      return res.json({
        success: false,
        message: `Order cannot be cancelled at this stage (${order.orderStatus})`,
      });

    const cancellableItems = order.items.filter(
      i => !["cancelled", "returned"].includes(i.status)
    );

    // For full-order cancel: sum up each item's actual paid amount (finalAmount preferred),
    // then cap at remaining refundable balance to prevent over-refunding on flat coupons.
    const rawRefund = cancellableItems.reduce((sum, item) => {
      const itemRefund = item.finalAmount != null
        ? item.finalAmount
        : Math.max(0, (item.lineTotal ?? 0) - (item.couponDiscount ?? 0));
      return sum + itemRefund;
    }, 0);
    const alreadyRefunded = order.refundAmount || 0;
    const maxRefundable   = Math.max(0, (order.totalAmount || 0) - alreadyRefunded);
    const refundAmount = order.paymentStatus === "paid"
      ? Math.min(rawRefund, maxRefundable)
      : 0;

    order.orderStatus  = "cancelled";
    order.cancelReason = reason.trim();
    order.cancelledAt  = new Date();

    order.items.forEach((item) => {
      if (!["cancelled", "returned"].includes(item.status)) {
        item.status       = "cancelled";
        item.cancelReason = reason.trim();
        item.cancelledAt  = new Date();
      }
    });

    if (refundAmount > 0) {
      order.refundAmount      = (order.refundAmount || 0) + refundAmount;
      order.refundStatus      = "processed";
      order.refundProcessedAt = new Date();
      order.paymentStatus     = "refunded";

      await creditWallet(
        userId,
        refundAmount,
        `Refund for cancelled order #${order.orderId}`
      );
    }

    await order.save();
    
    // Only restore stock if it was actually deducted (payment paid)
    if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") {
      await restoreStock(cancellableItems);
    }

    return res.json({
      success: true,
      message: refundAmount > 0
        ? `Order cancelled. ₹${refundAmount.toLocaleString("en-IN")} refunded to your wallet.`
        : "Order cancelled successfully.",
      refundAmount,
    });
  } catch (error) {
    console.error("cancelOrder error:", error);
    res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
};


export const requestReturn = async (req, res) => {
  try {
    const userId             = req.session.user._id;
    const { orderId }        = req.params;
    const { reason, itemId } = req.body;

    if (!reason?.trim())
      return res.json({ success: false, message: "Please provide a return reason" });

    if (!mongoose.Types.ObjectId.isValid(orderId))
      return res.json({ success: false, message: "Invalid order ID" });

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order)
      return res.json({ success: false, message: "Order not found" });

    const now = new Date();

    if (itemId) {
      if (order.discount > 0) {
        return res.json({
          success: false,
          message:
            "This order used a coupon. Individual items cannot be returned. Please return the entire order instead.",
        });
      }
      const item = order.items.find(i => i._id.toString() === itemId);
      if (!item)
        return res.json({ success: false, message: "Item not found in order" });

      if (item.status === "returned")
        return res.json({ success: false, message: "Item already returned" });

      const effectiveItemStatus = getEffectiveStatus(item, order.orderStatus);

      if (effectiveItemStatus !== "delivered")
        return res.json({ success: false, message: "Only delivered items can be returned" });

      item.status            = "returned";
      item.returnReason      = reason.trim();
      item.returnRequestedAt = now;
      item.returnApprovedAt  = now;

      const refundAmount = order.paymentStatus === "paid"
        ? (item.finalAmount ?? item.lineTotal ?? 0)
        : 0;

      if (refundAmount > 0) {
        order.refundAmount      = (order.refundAmount || 0) + refundAmount;
        order.refundStatus      = "processed";
        order.refundProcessedAt = now;

        //wallet controller
        await creditWallet(
          userId,
          refundAmount,
          `Refund for returned item "${item.productName}" in order #${order.orderId}`
        );
      }

      await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });

      //return refund for whole order
      const allDone = order.items.every(i => ["returned", "cancelled"].includes(i.status));
      if (allDone) {
        order.orderStatus = "returned";
        if (order.paymentStatus === "paid") order.paymentStatus = "refunded";
      }

      await order.save();

      return res.json({
        success: true,
        message: refundAmount > 0
          ? `Return submitted. ₹${refundAmount.toLocaleString("en-IN")} refunded to your wallet.`
          : "Return submitted successfully.",
        refundAmount,
        orderStatus: order.orderStatus,
      });
    }

    // full order return
    if (order.orderStatus !== "delivered")
      return res.json({ success: false, message: "Only delivered orders can be returned" });

    order.items.forEach((item) => {
      if (!["returned", "cancelled"].includes(item.status)) {
        item.status            = "returned";
        item.returnReason      = reason.trim();
        item.returnRequestedAt = now;
        item.returnApprovedAt  = now;
      }
    });

    order.orderStatus = "returned";

    const refundAmount = order.paymentStatus === "paid"
      ? order.items
          .filter(i => i.status === "returned")
          .reduce((sum, item) => sum + (item.finalAmount ?? item.lineTotal ?? 0), 0)
      : 0;

    if (refundAmount > 0) {
      order.refundAmount      = (order.refundAmount || 0) + refundAmount;
      order.refundStatus      = "processed";
      order.refundProcessedAt = now;
      order.paymentStatus     = "refunded";

      await creditWallet(
        userId,
        refundAmount,
        `Refund for returned order #${order.orderId}`
      );
    }

    await order.save();
    await restoreStock(order.items.filter(i => i.status === "returned"));

    return res.json({
      success: true,
      message: refundAmount > 0
        ? `Return submitted. ₹${refundAmount.toLocaleString("en-IN")} refunded to your wallet.`
        : "Return submitted successfully.",
      refundAmount,
    });
  } catch (error) {
    console.error("requestReturn error:", error);
    res.status(500).json({ success: false, message: "Failed to submit return" });
  }
};

// /user/orders/:orderId/invoice
export const downloadInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.session.user._id;

    const order = await Order.findOne({ _id: orderId, userId }).lean();
    if (!order) return res.status(404).send("Order not found");

    if (order.orderStatus !== "delivered") {
      return res.status(400).send("Invoice is only available for delivered orders");
    }

    //check if already invoice is there or not
    if (!order.invoiceNumber) {
      const count = await Order.countDocuments({ invoiceNumber: { $ne: null } });
      const invoiceNumber = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`;
      await Order.findByIdAndUpdate(order._id, {
        invoiceNumber,
        invoiceDate: new Date(),
      });
      order.invoiceNumber = invoiceNumber;
      order.invoiceDate = new Date();
    }

    //create pdf
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const INR = "Rs.";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${order.invoiceNumber}.pdf`
    );
    doc.pipe(res);

    const addr = order.shippingAddress || {};
    const invoiceDate = new Date(order.invoiceDate || order.updatedAt).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });
    const customerName = `${addr.firstName || ""} ${addr.lastName || ""}`.trim() || "Customer";

    // Helper: format currency
    // extracted up


    doc.fontSize(24).font("Helvetica-Bold").fillColor("#111111")
      .text("ElectroHub", 50, 45);
    doc.fontSize(9).font("Helvetica").fillColor("#888888")
      .text("Next-Gen Electronics", 50, 73);

    // Invoice info (right side)
    doc.fontSize(18).font("Helvetica-Bold").fillColor("#111111")
      .text("INVOICE", 350, 45, { width: 195, align: "right" });
    doc.fontSize(9).font("Helvetica").fillColor("#555555");
    doc.text(`Invoice:  ${order.invoiceNumber}`, 350, 70, { width: 195, align: "right" });
    doc.text(`Date:      ${invoiceDate}`, 350, 84, { width: 195, align: "right" });
    doc.text(`Order:    ${order.orderId}`, 350, 98, { width: 195, align: "right" });

    doc.moveTo(50, 118).lineTo(545, 118).strokeColor("#cccccc").lineWidth(0.5).stroke();

    let y = 135;
    const leftCol = 50;
    const rightCol = 310;
    const leftW = 240;
    const rightW = 235;

    // Labels
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#aaaaaa");
    doc.text("FROM", leftCol, y, { width: leftW });
    doc.text("BILL TO", rightCol, y, { width: rightW });
    y += 18;

    // Company name / Customer name
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111");
    doc.text("ElectroHub Electronics", leftCol, y, { width: leftW });
    doc.text(customerName, rightCol, y, { width: rightW });
    y += 20;

    // Build full address blocks as multi-line strings
    const fromLines = [
      "123 Tech Avenue, Silicon Valley",
      "Coimbatore, Tamil Nadu, India - 641001",
      "support@electrohub.com",
    ].join("\n");

    const billToLines = [
      addr.addressLine,
      [addr.street, addr.state].filter(Boolean).join(", "),
      [addr.country || "India", addr.pincode ? `- ${addr.pincode}` : ""].filter(Boolean).join(" "),
      addr.phone ? `Phone: ${addr.phone}` : null,
      addr.email ? `Email: ${addr.email}` : null,
    ].filter(Boolean).join("\n");

    // Render both blocks at the same y, with constrained widths
    doc.font("Helvetica").fontSize(9).fillColor("#555555");

    const fromStartY = y;
    doc.text(fromLines, leftCol, y, { width: leftW, lineGap: 4 });
    const fromEndY = fromStartY + doc.heightOfString(fromLines, { width: leftW, lineGap: 4 });

    doc.text(billToLines, rightCol, fromStartY, { width: rightW, lineGap: 4 });
    const billToEndY = fromStartY + doc.heightOfString(billToLines, { width: rightW, lineGap: 4 });

    // Advance y past whichever column is taller
    y = Math.max(fromEndY, billToEndY) + 8;

    // ── Items Table ────────────────────────────────────────────
    y += 15;

    // Table header background
    doc.rect(50, y, 495, 22).fill("#f5f5f5");

    // Table header text
    y += 6;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
    doc.text("#",          55,  y, { width: 20 });
    doc.text("PRODUCT",    80,  y, { width: 190 });
    doc.text("QTY",        275, y, { width: 40, align: "center" });
    doc.text("UNIT PRICE", 320, y, { width: 75, align: "right" });
    doc.text("DISCOUNT",   400, y, { width: 65, align: "right" });
    doc.text("AMOUNT",     470, y, { width: 75, align: "right" });

    y += 22;

    // Table rows
    let itemSubtotal = 0;
    let totalOfferDiscount = 0;
    let totalCouponDiscount = 0;

    (order.items || []).forEach((item, idx) => {
      const lineTotal = Number(item.lineTotal || item.unitPrice * item.quantity || 0);
      const couponDisc = Number(item.couponDiscount || 0);
      const finalAmt = Number(item.finalAmount ?? lineTotal);
      const offerDisc = lineTotal - finalAmt - couponDisc;

      itemSubtotal += lineTotal;
      totalOfferDiscount += Math.max(0, offerDisc);
      totalCouponDiscount += couponDisc;

      // New page if needed
      if (y > 700) { doc.addPage(); y = 50; }

      // Alternate row background
      if (idx % 2 === 1) {
        doc.rect(50, y - 4, 495, 24).fill("#fafafa");
      }

      doc.font("Helvetica").fontSize(9).fillColor("#333333");
      doc.text(String(idx + 1), 55, y, { width: 20 });
      doc.text(item.productName || "Product", 80, y, { width: 190 });
      doc.text(String(item.quantity), 275, y, { width: 40, align: "center" });
      doc.text(fmt(item.unitPrice || 0, INR), 320, y, { width: 75, align: "right" });

      const totalDisc = Math.max(0, offerDisc) + couponDisc;
      if (totalDisc > 0) {
        doc.fillColor("#16a34a")
          .text(`-${fmt(totalDisc, INR)}`, 400, y, { width: 65, align: "right" });
      } else {
        doc.fillColor("#aaaaaa")
          .text("--", 400, y, { width: 65, align: "right" });
      }

      doc.fillColor("#111111").font("Helvetica-Bold")
        .text(fmt(finalAmt, INR), 470, y, { width: 75, align: "right" });

      y += 24;
    });

    // Bottom border for table
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#cccccc").lineWidth(0.5).stroke();

    // ── Price Summary ──────────────────────────────────────────
    y += 20;

    const subtotal = Number(order.subtotal || itemSubtotal);
    const couponDiscount = Number(order.discount || 0);
    const shipping = Number(order.shipping || 0);
    const totalAmount = Number(order.totalAmount || 0);

    y = summaryRow(doc, y, "Subtotal:", fmt(subtotal, INR));
    if (totalOfferDiscount > 0) y = summaryRow(doc, y, "Offer Discount:", `-${fmt(totalOfferDiscount, INR)}`, { color: "#16a34a" });
    if (couponDiscount > 0) y = summaryRow(doc, y, `Coupon${order.couponCode ? ` (${order.couponCode})` : ""}:`, `-${fmt(couponDiscount, INR)}`, { color: "#2563eb" });
    y = summaryRow(doc, y, "Shipping:", shipping === 0 ? "FREE" : fmt(shipping, INR), { color: shipping === 0 ? "#16a34a" : "#444444" });

    // Total divider
    doc.moveTo(340, y).lineTo(545, y).strokeColor("#333333").lineWidth(1).stroke();
    y += 10;
    y = summaryRow(doc, y, "Total Paid:", fmt(totalAmount, INR), { bold: true, large: true, color: "#111111" });

    // Payment info
    y += 5;
    doc.font("Helvetica").fontSize(8).fillColor("#888888");
    doc.text(`Payment Method: ${(order.paymentMethod || "N/A").toUpperCase()}`, 340, y, { width: 205, align: "right" });
    y += 14;
    doc.text(`Payment Status: ${(order.paymentStatus || "N/A").toUpperCase()}`, 340, y, { width: 205, align: "right" });

    // ── Footer ─────────────────────────────────────────────────
    const footerY = 755;
    doc.moveTo(50, footerY).lineTo(545, footerY).strokeColor("#dddddd").lineWidth(0.5).stroke();

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#666666")
      .text("Thank you for shopping with ElectroHub!", 50, footerY + 12, { align: "center", width: 495 });
    doc.font("Helvetica").fontSize(7).fillColor("#aaaaaa")
      .text("This is a computer-generated invoice and does not require a signature.", 50, footerY + 28, { align: "center", width: 495 });

    doc.end();
  } catch (error) {
    console.error("downloadInvoice error:", error);
    if (!res.headersSent) {
      res.status(500).send("Could not generate invoice");
    }
  }
};


