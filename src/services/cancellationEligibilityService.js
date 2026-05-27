import { getCouponMinimumPurchase, hasAppliedCoupon, validateOrderCoupon } from "./couponValidationService.js";

const INACTIVE_ITEM_STATUSES = ["cancelled", "returned"];

function toAmount(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

export function getItemOriginalValue(item) {
  return toAmount(item.lineTotal ?? item.unitPrice * item.quantity);
}

export function getActiveItems(order) {
  return (order.items || []).filter(
    (item) => !INACTIVE_ITEM_STATUSES.includes(item.status),
  );
}

export function getItemsSubtotal(items) {
  return (items || []).reduce(
    (subtotalAccumulator, item) => subtotalAccumulator + getItemOriginalValue(item),
    0,
  );
}

//how many value can the user cancel without breaking coupon min purchase
export function getMaximumCancellableAmount(order) {
  const activeSubtotal = getItemsSubtotal(getActiveItems(order));
  const minPurchaseAmount = hasAppliedCoupon(order)
    ? getCouponMinimumPurchase(order)
    : 0;

  return Math.max(0, activeSubtotal - minPurchaseAmount);
}

export async function validatePartialCancellation(order, itemsToCancel) {
  const activeItems = getActiveItems(order);
  const cancellingItemIds = new Set(
    (itemsToCancel || []).map((item) => item._id.toString()),
  );
  const cancellingAllActiveItems = activeItems.every((item) =>
    cancellingItemIds.has(item._id.toString()),
  );

  if (cancellingAllActiveItems || !hasAppliedCoupon(order)) {
    return {
      allowed: true,
      cancellingAllActiveItems,
      activeSubtotal: getItemsSubtotal(activeItems),
      remainingSubtotal: 0,
      maxCancellableAmount: getMaximumCancellableAmount(order),
    };
  }

  const couponValidation = await validateOrderCoupon(order);
  if (!couponValidation.valid) {
    return {
      allowed: false,
      reason: "coupon_invalid",
      message: couponValidation.message,
      activeSubtotal: getItemsSubtotal(activeItems),
      remainingSubtotal: getItemsSubtotal(activeItems),
      minPurchaseAmount: couponValidation.minPurchaseAmount,
      maxCancellableAmount: getMaximumCancellableAmount(order),
    };
  }

  const remainingItems = activeItems.filter(
    (item) => !cancellingItemIds.has(item._id.toString()),
  );
  const activeSubtotal = getItemsSubtotal(activeItems);
  const remainingSubtotal = getItemsSubtotal(remainingItems);
  const minPurchaseAmount = couponValidation.minPurchaseAmount;
  const maxCancellableAmount = Math.max(0, activeSubtotal - minPurchaseAmount);

  if (remainingSubtotal < minPurchaseAmount) {
    return {
      allowed: false,
      reason: "coupon_minimum_lost",
      message:
        "Cancelling these items may affect your coupon eligibility.",
      activeSubtotal,
      remainingSubtotal,
      minPurchaseAmount,
      maxCancellableAmount,
    };
  }

  return {
    allowed: true,
    cancellingAllActiveItems,
    activeSubtotal,
    remainingSubtotal,
    minPurchaseAmount,
    maxCancellableAmount,
  };
}

export async function buildItemCancellationSafety(order) {
  const safety = {};
  const activeItems = getActiveItems(order);
  const activeSubtotal = getItemsSubtotal(activeItems);
  const maxCancellableAmount = getMaximumCancellableAmount(order);

  for (const item of order.items || []) {
    const itemId = item._id.toString();
    const itemValue = getItemOriginalValue(item);

    if (INACTIVE_ITEM_STATUSES.includes(item.status)) {
      safety[itemId] = {
        allowed: false,
        message: "This item is already closed.",
        itemValue,
        activeSubtotal,
        maxCancellableAmount,
      };
      continue;
    }

    const eligibility = await validatePartialCancellation(order, [item]);
    safety[itemId] = {
      ...eligibility,
      itemValue,
      maxCancellableAmount,
    };
  }

  return safety;
}
