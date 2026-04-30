import mongoose from "mongoose";

const { Schema } = mongoose;

const orderItemSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: {
      type: Schema.Types.ObjectId,
      ref: "Variant",
      required: true,
    },
    productName: {
      type: String,
      required: true,
    },
    productImage: {
      type: String,
      default: "",
    },
    variantAttributes: {
      type: Schema.Types.Mixed,
      default: {},
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    // NEW: proportional share of the order-level coupon
    couponDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // NEW: what the user actually paid — use this for refunds
    finalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
status: {
  type: String,
  enum: ["pending", "confirmed", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "returned", "return_requested", "return_rejected"],
  default: "pending",
},
    cancelReason: { type: String, default: null },
    returnReason: { type: String, default: null },
    returnRequestedAt: { type: Date, default: null },
    returnApprovedAt: { type: Date, default: null },
    returnRejectedAt: { type: Date, default: null },
    returnRejectionReason: { type: String, default: null },
  },
  { _id: true },
);

const shippingAddressSchema = new Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, required: true },
    addressLine: { type: String, required: true },
    street: { type: String, required: true },
    state: { type: String, required: true },
    country: { type: String, required: true },
    pincode: { type: String, required: true },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      unique: true,
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (arr) => arr.length > 0,
        message: "Order must have at least one item",
      },
    },
    shippingAddress: {
      type: shippingAddressSchema,
      required: true,
    },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    shipping: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    couponCode: { type: String, default: null },
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", default: null },
    couponStatus: {
      type: String,
      enum: ["applied", "removed", "adjusted"],
      default: "applied",
    },
    paymentMethod: {
      type: String,
      enum: ["razorpay", "cod", "wallet", "upi", "card", "netBanking", "emi"],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded", "partially_refunded", "adjusted"],
      default: "pending",
    },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    razorpaySignature: { type: String, default: null },
orderStatus: {
  type: String,
  enum: ["pending", "confirmed", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "returned", "return_requested", "partially_cancelled", "expired", "return_rejected"],
  default: "pending",
},
paymentAttempts: [
  {
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String, default: null },
    razorpaySignature: { type: String, default: null },
    status: {
      type: String,
      enum: ["created", "failed", "success"],
      default: "created",
    },
    createdAt: { type: Date, default: Date.now },
  },
],
    cancelReason: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    expectedDeliveryDate: {
      type: Date,
      default: () => {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        return d;
      },
    },
    deliveredAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0, min: 0 },
    refundStatus: {
      type: String,
      enum: ["none", "pending", "processed"],
      default: "none",
    },
    refundProcessedAt: { type: Date, default: null },
    invoiceNumber: { type: String, unique: true, sparse: true },
    invoiceDate: { type: Date },
  },
  { timestamps: true },
);

orderSchema.pre("save", async function () {
  if (!this.orderId) {
    const count = await mongoose.model("Order").countDocuments();
    this.orderId = `ORD-${Date.now()}-${String(count + 1).padStart(4, "0")}`;
  }
});

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ createdAt: -1 });

const Order = mongoose.model("Order", orderSchema);
export default Order;
