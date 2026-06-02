const INACTIVE_ITEM_STATUSES = ["cancelled", "returned"];//with this status are in active

function toAmount(value) {//convert into number to prevent 0
  return Math.max(0, Math.round(Number(value || 0)));
}

export function getItemOriginalValue(item) {//caculate total value of 1 item
  return toAmount(item.lineTotal ?? item.unitPrice * item.quantity);
}

export function getActiveItems(order) {//remove cancelled or returned items
  return (order.items || []).filter(
    (item) => !INACTIVE_ITEM_STATUSES.includes(item.status),
  );
}

export function getItemsSubtotal(items) {//caculate total
  return (items || []).reduce(
    (subtotalAccumulator, item) => subtotalAccumulator + getItemOriginalValue(item),
    0,
  );
}

export function getMaximumCancellableAmount(order) {
  const activeSubtotal = getItemsSubtotal(getActiveItems(order));
  const minPurchaseAmount = order.couponCode ? toAmount(order.couponSnapshot?.minPurchaseAmount) : 0;
  return Math.max(0, activeSubtotal - minPurchaseAmount);
}

export async function validatePartialCancellation(order, itemsToCancel) {
  const activeItems = getActiveItems(order);
  const cancellingItemIds = new Set(
    (itemsToCancel || []).map((item) => item._id.toString()),
  );
  const remainingItems = activeItems.filter(
    (item) => !cancellingItemIds.has(item._id.toString()),
  );

  const activeSubtotal = getItemsSubtotal(activeItems);
  const remainingSubtotal = getItemsSubtotal(remainingItems);
  const minPurchaseAmount = order.couponCode ? toAmount(order.couponSnapshot?.minPurchaseAmount) : 0;
  const maxCancellableAmount = Math.max(0, activeSubtotal - minPurchaseAmount);

  if (remainingItems.length > 0 && order.couponCode && remainingSubtotal < minPurchaseAmount) {
    return {
      allowed: false,
      reason: "coupon_minimum_lost",
      message: "Cancelling these items may affect your coupon eligibility.",
      activeSubtotal,
      remainingSubtotal,
      minPurchaseAmount,
      maxCancellableAmount,
    };
  }

  return {
    allowed: true,
    activeSubtotal,
    remainingSubtotal,
    minPurchaseAmount,
    maxCancellableAmount,
  };
}

export async function buildItemCancellationSafety(order) {
  const safety = {};
  const activeSubtotal = getItemsSubtotal(getActiveItems(order));
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
