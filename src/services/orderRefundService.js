import { creditWallet } from "../controllers/user/walletController.js";

const REFUNDABLE_PAYMENT_STATUSES = ["paid", "partially_refunded", "adjusted"];
function money(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

export function canRefundToWallet(order) {
  return (
    order.paymentMethod !== "cod" &&
    REFUNDABLE_PAYMENT_STATUSES.includes(order.paymentStatus)
  );
}

export function getItemRefundAmount(item, order) {
  const lineTotal = money(item.lineTotal ?? item.unitPrice * item.quantity);

  if (item.paidAmount != null) return money(item.paidAmount);
  if (item.finalPrice != null) return money(item.finalPrice);
  if (item.finalAmount != null) return money(item.finalAmount);

  return money(lineTotal - money(item.couponDiscount));
}

export function calculateRefundAmount(order, refundItems) {
  if (!canRefundToWallet(order)) return 0;

  const alreadyRefunded = money(order.refundAmount);
  const maxRefundable = Math.max(0, money(order.totalAmount) - alreadyRefunded);
  if (maxRefundable <= 0) return 0;

  const itemRefundTotal = (refundItems || []).reduce(
    (sum, item) => sum + getItemRefundAmount(item, order),
    0,
  );

  return Math.min(itemRefundTotal, maxRefundable);
}

export async function refundToWallet(order, amount, description) {
  const refundAmount = money(amount);
  if (refundAmount <= 0) return 0;

  order.refundAmount = money(order.refundAmount) + refundAmount;
  order.refundStatus = "processed";
  order.refundProcessedAt = new Date();

  const fullyRefunded = order.refundAmount >= money(order.totalAmount);
  order.paymentStatus = fullyRefunded ? "refunded" : "partially_refunded";

  await creditWallet(
    order.userId,
    refundAmount,
    description,
    "order_refund",
    order._id,
  );

  return refundAmount;
}

export async function refundItemsToWallet(order, refundItems, description) {
  const refundAmount = calculateRefundAmount(order, refundItems);
  return refundToWallet(order, refundAmount, description);
}
