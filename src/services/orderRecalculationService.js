const TERMINAL_ITEM_STATUSES = ["cancelled", "returned"];

export function getEffectiveItemStatus(item, orderStatus) {
  if (item.status && item.status !== "pending") return item.status;
  return orderStatus;
}

export function recalculateOrderStatus(order) {
  const statuses = (order.items || []).map((item) =>
    getEffectiveItemStatus(item, order.orderStatus),
  );

  if (statuses.length === 0) return order.orderStatus;

  if (statuses.every((status) => status === "cancelled")) {
    order.orderStatus = "cancelled";
  } else if (statuses.every((status) => status === "returned")) {
    order.orderStatus = "returned";
  } else if (statuses.every((status) => status === "delivered")) {
    order.orderStatus = "delivered";
  } else if (statuses.some((status) => status === "return_requested")) {
    const activeStatuses = statuses.filter(
      (status) => !TERMINAL_ITEM_STATUSES.includes(status),
    );
    if (activeStatuses.every((status) => status === "return_requested")) {
      order.orderStatus = "return_requested";
    }
  } else if (statuses.some((status) => status === "cancelled")) {
    order.orderStatus = "partially_cancelled";
  } else {
    const priority = ["out_for_delivery", "shipped", "confirmed", "pending"];
    order.orderStatus =
      priority.find((status) => statuses.includes(status)) || order.orderStatus;
  }

  return order.orderStatus;
}
