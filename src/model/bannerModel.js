import mongoose from "mongoose";

const bannerSchema = new mongoose.Schema(
  {
    type: {
      type:     String,
      enum:     ["hero", "promo"],
      required: true,
    },
    title:     { type: String, trim: true, default: "" },
    subtitle:  { type: String, trim: true, default: "" },
    badgeText: { type: String, trim: true, default: "" },
    offerText: { type: String, trim: true, default: "" },
    image:     { type: String, default: "" },
    countdownEnabled: { type: Boolean, default: false },
    countdownEndDate: { type: Date,    default: null  },
    offerId:   { type: mongoose.Schema.Types.ObjectId, ref: "Offer", default: null },
    redirectType: { type: String, enum: ["product", "category", "custom"], default: "product" },
    redirectValue: { type: String, default: "" },
    status:    { type: String, enum: ["active","inactive"], default: "active" },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

bannerSchema.index({ isDeleted: 1, status: 1, type: 1 });

export default mongoose.model("Banner", bannerSchema);