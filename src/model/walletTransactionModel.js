import mongoose from "mongoose";
import crypto from "crypto";

const { Schema } = mongoose;

const walletTransactionSchema = new Schema(
  {
    walletId: {
      type: Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    transactionId: {
      type: String,
      unique: true,
      default: () => `TXN-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
    },
    transactionType: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
      enum: ["order_refund", "order_payment", "wallet_topup", "admin_adjustment", "refund_adjustment", "referral_bonus", "referral_reward"],
      required: true,
    },
    referenceId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    description: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

walletTransactionSchema.index({ walletId: 1, createdAt: -1 });

const WalletTransaction = mongoose.model("WalletTransaction", walletTransactionSchema);
export default WalletTransaction;
